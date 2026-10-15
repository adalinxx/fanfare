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
import * as read from "../client/read.mjs";
import { chainSpec, tip, view, volumeLoader } from "../client/state.mjs";
import * as write from "../client/write.mjs";

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

async function api(path) {
  const url = new URL(path, node);
  url.searchParams.set("chainPath", CHAIN.join("/"));
  const response = await fetch(url);
  return response.ok ? response.json() : undefined;
}

const balance = async (who) => BigInt((await api(`/api/state/account/${who.address}`))?.balance ?? 0);
const nonce = async (who) => BigInt((await api(`/api/state/account/${who.address}`))?.nonce ?? 0);

const volumes = () => new sdk.VolumeClient(new sdk.HTTPVolumeTransport(`${node}/volumes`, { chainPath: CHAIN }));

/** The chain's state at the node's tip, read through the client. */
async function state() {
  const client = volumes();
  const { generalStateCID } = await tip(sdk, node, CHAIN, client);
  return view(volumeLoader(client, sdk.decodeDagCbor), generalStateCID);
}
const value = async (key) => (await state()).get(key);

/** `buyer` buys ticket `seat` at the price the client reads, as the app would. */
async function buy(buyer, seat) {
  const ticket = await read.ticket(await state(), artist.address, `${SHOW}/${seat}`);
  const { actions, payments } = write.buy(ticket, buyer.address);
  const body = write.transaction({ owner: buyer.address, actions, payments, fee: 1n, nonce: await nonce(buyer), chainPath: CHAIN });
  await admitted(`${buyer === alice ? "Alice" : "Bob"} buys ticket ${seat}`, [buyer], body);
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

const SHOW = "berlin-night-1";
const ticket = (seat) => `own/${artist.address}/${SHOW}/${seat}`;
const listing = `item/${artist.address}/${SHOW}`;
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
  {
    const client = volumes();
    assert.ok(read.runsFanfare(await chainSpec(sdk, client, (await tip(sdk, node, CHAIN, client)).specCID)));
    console.log("the client reads the chain's spec and finds the Fanfare policy");
  }

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
  await buy(alice, 3);
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
  await refused("Bob mints a ticket for the artist's show", [bob], {
    actions: [{ key: ticket(5), newValue: bob.address }],
    accountActions: pay(bob, artist, 250n),
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
  await buy(bob, 4);
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
  await buy(alice, 3);
  await until("the resale is mined", async () => (await value(ticket(3))) === alice.address);
  assert.equal(await balance(bob), bobBefore + 400n);
  console.log("Bob resold ticket 3 at his own price; Alice bought it alone and Bob got 400");
  assert.deepEqual((await read.held(await state(), artist.address, alice.address)).map((t) => t.id), [`${SHOW}/3`]);
  assert.deepEqual((await read.held(await state(), artist.address, bob.address)).map((t) => t.id), [`${SHOW}/4`]);
  console.log("the client lists each fan's tickets");
} finally {
  try { lattice("mine", "stop"); } catch {}
  try { lattice("down"); } catch {}
}
