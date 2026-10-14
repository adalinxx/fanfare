// Ticket sales and transfers against a real node: a private host mines Nexus
// and an artist chain running the built Fanfare policy. The artist lists a
// show and mints its tickets at a price; a fan buys one, transfers it, and
// every way of taking a ticket without paying for it or holding it is refused.
// Last, a fan resells a ticket at their own price to a buyer who completes it
// alone.
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

const ITEM = "5.berlin-night-1"; // five tickets
const ticket = (serial) => `own/${artist.address}/${ITEM}/${serial}`;
const listing = `item/${artist.address}/${ITEM}`;
const atPrice = (who, price) => `${who.address}@${price}`;

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

  await admitted("listing and mint", [artist], {
    actions: [
      { key: listing, newValue: '{"kind":"ticket","title":"Berlin"}' },
      ...[0, 1, 2, 3, 4].map((serial) => ({ key: ticket(serial), newValue: atPrice(artist, 250) })),
    ],
    accountActions: fee(artist),
  });
  await until("the mint is mined", async () => (await value(ticket(4))) === atPrice(artist, 250));
  console.log("artist listed the show and minted five tickets at 250");

  // Primary sale: Alice alone signs and pays the artist.
  const before = await balance(artist);
  await admitted("Alice buys ticket 3", [alice], {
    actions: [{ key: ticket(3), oldValue: atPrice(artist, 250), newValue: alice.address }],
    accountActions: pay(alice, artist, 250n),
  });
  await until("Alice's ticket is mined", async () => (await value(ticket(3))) === alice.address);
  assert.equal(await balance(artist), before + 250n);
  console.log("Alice bought ticket 3; the artist was paid 250");

  // Ways of taking a ticket without paying for it or holding it.
  await refused("Bob buys ticket 3 at its old price", [bob], {
    actions: [{ key: ticket(3), oldValue: atPrice(artist, 250), newValue: bob.address }],
    accountActions: pay(bob, artist, 250n),
  });
  await refused("Bob takes Alice's unpriced ticket, paying her", [bob], {
    actions: [{ key: ticket(3), oldValue: alice.address, newValue: bob.address }],
    accountActions: pay(bob, alice, 1000n),
  });
  await refused("Bob mints a sixth ticket", [bob], {
    actions: [{ key: ticket(5), newValue: bob.address }],
    accountActions: pay(bob, artist, 250n),
  });
  await refused("the artist mints a sixth ticket", [artist], {
    actions: [{ key: ticket(5), newValue: artist.address }],
    accountActions: fee(artist),
  });
  await refused("Bob underpays for ticket 4", [bob], {
    actions: [{ key: ticket(4), oldValue: atPrice(artist, 250), newValue: bob.address }],
    accountActions: pay(bob, artist, 249n),
  });
  await refused("Bob pays himself for ticket 4", [bob], {
    actions: [{ key: ticket(4), oldValue: atPrice(artist, 250), newValue: bob.address }],
    accountActions: [{ owner: bob.address, delta: -1n }],
  });
  await refused("Alice deletes her ticket", [alice], {
    actions: [{ key: ticket(3), oldValue: alice.address }],
    accountActions: fee(alice),
  });
  await refused("the artist takes Alice's ticket back", [artist], {
    actions: [{ key: ticket(3), oldValue: alice.address, newValue: artist.address }],
    accountActions: fee(artist),
  });
  await refused("the artist deletes the listing", [artist], {
    actions: [{ key: listing, oldValue: '{"kind":"ticket","title":"Berlin"}' }],
    accountActions: fee(artist),
  });

  // The same buyer can buy when they pay, so the refusals above were about the
  // ticket, not about Bob.
  await admitted("Bob buys ticket 4", [bob], {
    actions: [{ key: ticket(4), oldValue: atPrice(artist, 250), newValue: bob.address }],
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

  // Resale: Bob prices ticket 3 at 400; Alice buys it alone.
  await admitted("Bob prices ticket 3 at 400", [bob], {
    actions: [{ key: ticket(3), oldValue: bob.address, newValue: atPrice(bob, 400) }],
    accountActions: fee(bob),
  });
  await until("the price is mined", async () => (await value(ticket(3))) === atPrice(bob, 400));
  await refused("Alice buys ticket 3 as if it were still unpriced", [alice], {
    actions: [{ key: ticket(3), oldValue: bob.address, newValue: alice.address }],
    accountActions: pay(alice, bob, 400n),
  });
  const bobBefore = await balance(bob);
  await admitted("Alice buys ticket 3 from Bob", [alice], {
    actions: [{ key: ticket(3), oldValue: atPrice(bob, 400), newValue: alice.address }],
    accountActions: pay(alice, bob, 400n),
  });
  await until("the resale is mined", async () => (await value(ticket(3))) === alice.address);
  assert.equal(await balance(bob), bobBefore + 400n);
  console.log("Bob resold ticket 3 at his own price; Alice bought it alone and Bob got 400");
} finally {
  try { lattice("mine", "stop"); } catch {}
  try { lattice("down"); } catch {}
}
