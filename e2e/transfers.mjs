// Ticket sales and transfers against a real node: a private host mines Nexus
// and an artist chain running the built Fanfare policy. The artist lists an
// item, a fan buys a ticket, transfers it, and every way of taking a ticket
// without paying for it or holding it is refused. Last, a resale that moves
// the ticket and the payment in one transaction signed by both people.
//
//   LATTICE=<lattice-node>/.build/debug/lattice \
//   LATTICE_SDK=<lattice-sdk>/packages/sdk/dist/index.js node e2e/transfers.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { get, tipGeneralState, volumeLoader } from "../client/state.mjs";

const sdk = await import(process.env.LATTICE_SDK);
const here = (path) => fileURLToPath(new URL(path, import.meta.url));
const CHAIN = ["Nexus", "band"];
const [listen, rpc, publicRead] = [25011, 29090, 29091];
const node = `http://127.0.0.1:${publicRead}`;
const MODULE = here("../policy/target/wasm32-unknown-unknown/release/fanfare_policy.wasm");

const root = mkdtempSync(`${tmpdir()}/fanfare-e2e-`);
const lattice = (...args) => execFileSync(process.env.LATTICE, [...args, "--root", root], { encoding: "utf8" });
function configure(change) {
  const file = `${root}/lattice.json`;
  const topology = JSON.parse(readFileSync(file, "utf8"));
  change(topology);
  writeFileSync(file, JSON.stringify(topology, null, 2));
}

const account = () => sdk.accountFromPrivateKey(sdk.generatePrivateKey());
const [miner, artist, alice, bob] = [account(), account(), account(), account()];

async function until(label, condition, seconds = Number(process.env.E2E_SECONDS ?? 300)) {
  const deadline = Date.now() + seconds * 1000;
  let failure;
  for (;;) {
    const value = await condition().catch((error) => void (failure = error));
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`, { cause: failure });
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

async function read(path) {
  const url = new URL(path, node);
  url.searchParams.set("chainPath", CHAIN.join("/"));
  const response = await fetch(url);
  return response.ok ? response.json() : undefined;
}

const balance = async (who) => BigInt((await read(`/api/state/account/${who.address}`))?.balance ?? 0);
const nonce = async (who) => BigInt((await read(`/api/state/account/${who.address}`))?.nonce ?? 0);

async function value(key) {
  const volumes = new sdk.VolumeClient(new sdk.HTTPVolumeTransport(`${node}/volumes`, { chainPath: CHAIN }));
  const rootCID = await tipGeneralState(sdk, node, CHAIN, volumes);
  return get(volumeLoader(volumes, sdk.decodeDagCbor), rootCID, key);
}

/** Signs `body` by every account in `signers` and submits it. Resolves to `{ ok, status, text }`. */
async function submit(signers, { actions = [], accountActions = [], nonce: n }) {
  const body = {
    accountActions,
    actions,
    depositActions: [],
    receiptActions: [],
    withdrawalActions: [],
    signers: signers.map((signer) => signer.address),
    nonce: n ?? (await nonce(signers[0])),
    chainPath: [...CHAIN],
  };
  const signatures = {};
  for (const signer of signers) {
    const { publicKey, signature } = sdk.signTransactionBody(body, signer.privateKey);
    signatures[publicKey] = signature;
  }
  const response = await fetch(new URL("/transactions", node), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(sdk.transactionPayload(signatures, body)),
  });
  return { ok: response.ok, status: response.status, text: await response.text() };
}

/** `from` pays `to` `amount` with a fee of 1. */
const pay = (from, to, amount) => [
  { owner: from.address, delta: -(amount + 1n) },
  { owner: to.address, delta: amount },
];
const fee = (from) => [{ owner: from.address, delta: -1n }];

async function admitted(label, signers, transaction) {
  const result = await submit(signers, transaction);
  assert.ok(result.ok, `${label}: ${result.status} ${result.text}`);
}

async function refused(label, signers, transaction) {
  const result = await submit(signers, transaction);
  assert.ok(!result.ok, `${label} was admitted`);
  console.log(`  refused: ${label} (${result.status} ${result.text.trim()})`);
}

const ITEM = "250.5.0.berlin-night-1"; // price 250, five tickets, never closes
const ticket = (serial) => `own/${artist.address}/${ITEM}/${serial}`;

try {
  lattice("init");
  configure((topology) => {
    Object.assign(topology, { listen, rpc, publicRead, webSocket: 0, publicSubmit: true });
    topology.publicReadExpensiveRate = 1000;
    topology.peers = [];
    topology.mine = { worker: "cpu", workers: 1, batchSize: 100000 };
  });
  lattice("up");
  lattice("child", "create", CHAIN.join("/"), "--spec", here("../chain/spec.json"), "--policy-module", MODULE);
  configure((topology) => {
    topology.mine.recipients = { [CHAIN.join("/")]: miner.address };
  });
  lattice("mine", "start");

  await until("the artist chain is mined", async () => (await balance(miner)) >= 10_000n);
  console.log("artist chain mined");

  await admitted("funding", [miner], {
    accountActions: [
      { owner: miner.address, delta: -6001n },
      { owner: artist.address, delta: 2000n },
      { owner: alice.address, delta: 2000n },
      { owner: bob.address, delta: 2000n },
    ],
  });
  await until("fans funded", async () => (await balance(bob)) === 2000n);
  console.log("artist and fans funded");

  await admitted("listing", [artist], {
    actions: [{ key: `item/${artist.address}/${ITEM}`, newValue: '{"kind":"ticket","title":"Berlin"}' }],
    accountActions: fee(artist),
  });
  await until("the listing is mined", async () => (await value(`item/${artist.address}/${ITEM}`)) !== undefined);
  console.log("artist listed the show");

  // Primary sale.
  const before = await balance(artist);
  await admitted("Alice buys ticket 3", [alice], {
    actions: [{ key: ticket(3), newValue: alice.address }],
    accountActions: pay(alice, artist, 250n),
  });
  await until("Alice's ticket is mined", async () => (await value(ticket(3))) === alice.address);
  assert.equal(await balance(artist), before + 250n);
  console.log("Alice bought ticket 3; the artist was paid 250");

  // Ways of taking a ticket without paying for it or holding it.
  await refused("Bob buys ticket 3 again", [bob], {
    actions: [{ key: ticket(3), newValue: bob.address }],
    accountActions: pay(bob, artist, 250n),
  });
  await refused("Bob takes Alice's ticket", [bob], {
    actions: [{ key: ticket(3), oldValue: alice.address, newValue: bob.address }],
    accountActions: fee(bob),
  });
  await refused("Bob buys ticket 5 of 5", [bob], {
    actions: [{ key: ticket(5), newValue: bob.address }],
    accountActions: pay(bob, artist, 250n),
  });
  await refused("Bob underpays for ticket 4", [bob], {
    actions: [{ key: ticket(4), newValue: bob.address }],
    accountActions: pay(bob, artist, 249n),
  });
  await refused("Bob pays himself for ticket 4", [bob], {
    actions: [{ key: ticket(4), newValue: bob.address }],
    accountActions: [{ owner: bob.address, delta: -1n }],
  });
  await refused("Alice deletes her ticket", [alice], {
    actions: [{ key: ticket(3), oldValue: alice.address }],
    accountActions: fee(alice),
  });
  await refused("the artist deletes the listing", [artist], {
    actions: [{ key: `item/${artist.address}/${ITEM}`, oldValue: '{"kind":"ticket","title":"Berlin"}' }],
    accountActions: fee(artist),
  });

  // The same buyer can buy when they pay, so the refusals above were about the
  // ticket, not about Bob.
  await admitted("Bob buys ticket 4", [bob], {
    actions: [{ key: ticket(4), newValue: bob.address }],
    accountActions: pay(bob, artist, 250n),
  });
  await until("Bob's ticket is mined", async () => (await value(ticket(4))) === bob.address);
  console.log("Bob bought ticket 4 when he paid");

  // Transfer by the holder.
  await admitted("Alice gives ticket 3 to Bob", [alice], {
    actions: [{ key: ticket(3), oldValue: alice.address, newValue: bob.address }],
    accountActions: fee(alice),
  });
  await until("the transfer is mined", async () => (await value(ticket(3))) === bob.address);
  console.log("Alice transferred ticket 3 to Bob");

  await refused("Alice transfers ticket 3 again (stale holder)", [alice], {
    actions: [{ key: ticket(3), oldValue: alice.address, newValue: alice.address }],
    accountActions: fee(alice),
  });
  await refused("Alice takes ticket 3 back from Bob", [alice], {
    actions: [{ key: ticket(3), oldValue: bob.address, newValue: alice.address }],
    accountActions: fee(alice),
  });

  // Resale: Bob sells ticket 3 back to Alice for 400 in one transaction both
  // sign. A transaction carries one nonce, and it must be the next nonce of
  // every signer.
  const resale = {
    actions: [{ key: ticket(3), oldValue: bob.address, newValue: alice.address }],
    accountActions: pay(alice, bob, 400n),
  };
  const [bobNonce, aliceNonce] = [await nonce(bob), await nonce(alice)];
  console.log(`resale: Bob's next nonce is ${bobNonce}, Alice's is ${aliceNonce}`);
  await refused("resale at Bob's nonce", [bob, alice], { ...resale, nonce: bobNonce });

  // At the higher nonce the node holds the resale until the signer who is
  // behind catches up.
  const [behind, ahead] = bobNonce < aliceNonce ? [bob, alice] : [alice, bob];
  const shared = await nonce(ahead);
  const bobBefore = await balance(bob);
  await admitted("resale at the higher nonce", [bob, alice], { ...resale, nonce: shared });
  const seen = new Set([(await read("/api/block/latest")).hash]);
  await until("three more blocks", async () => seen.add((await read("/api/block/latest")).hash).size > 3);
  assert.equal(await value(ticket(3)), bob.address);
  console.log(`resale admitted at nonce ${shared}, still pending three blocks later`);

  let catchUpFees = 0n;
  for (let n = await nonce(behind); n < shared; n++) {
    await admitted("catch-up", [behind], { accountActions: fee(behind), nonce: n });
    catchUpFees += 1n;
  }
  await until("the resale is mined", async () => (await value(ticket(3))) === alice.address);
  assert.equal(await balance(bob), bobBefore + 400n - (behind === bob ? catchUpFees : 0n));
  console.log("the signer behind caught up; resale mined: ticket 3 is Alice's and Bob got 400");
} finally {
  try { lattice("mine", "stop"); } catch {}
  try { lattice("down"); } catch {}
}
