// The whole journey on two nodes. The artist's node mines Nexus, the Fanfare
// home chain and the artist's chain, launched from the app's default spec. A
// fan's node peers with it and, while running, starts hosting the artist
// chain: that is all joining as a node takes. Everything the fans do goes
// through the fan's node, written as the wallet requests Fanfare hands
// `window.lattice` and signed the way the wallet signs them.
//
// Alice buys the artist's coin on the market, buys a ticket, and resells it
// to Bob, whose earlier try at the same ticket the client explains. She buys
// a Q&A slot and asks; the artist answers. She buys a shirt and leaves a
// shipping address only the artist opens. At the door, Bob's wallet answers
// the challenge and the artist's staff checks him in.
//
//   LATTICE=<lattice-node>/.build/debug/lattice \
//   LATTICE_SDK=<lattice-sdk>/packages/sdk/dist/index.js node e2e/journey.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import * as door from "../client/door.mjs";
import * as launch from "../client/launch.mjs";
import * as market from "../client/market.mjs";
import * as read from "../client/read.mjs";
import { explain } from "../client/refusal.mjs";
import * as ship from "../client/ship.mjs";
import { chainSpec, premineRecipient, tip, view, volumeLoader } from "../client/state.mjs";
import * as wallet from "../client/wallet.mjs";
import * as write from "../client/write.mjs";

const sdk = await import(process.env.LATTICE_SDK);
const here = (path) => fileURLToPath(new URL(path, import.meta.url));
const MODULE = here("../policy/target/wasm32-unknown-unknown/release/fanfare_policy.wasm");
const CHAIN = launch.chainPath("band");
const ORIGIN = "https://fanfare.example";

function host(name, ports) {
  const root = mkdtempSync(`${tmpdir()}/fanfare-${name}-`);
  const lattice = (...args) => execFileSync(process.env.LATTICE, [...args, "--root", root], { encoding: "utf8" });
  const configure = (change) => {
    const file = `${root}/lattice.json`;
    const topology = JSON.parse(readFileSync(file, "utf8"));
    change(topology);
    writeFileSync(file, JSON.stringify(topology, null, 2));
  };
  return { name, root, lattice, configure, ...ports, url: `http://127.0.0.1:${ports.publicRead}` };
}
const artistNode = host("artist", { listen: 25031, rpc: 29290, publicRead: 29291 });
const fanNode = host("fan", { listen: 25032, rpc: 29292, publicRead: 29293 });

const account = () => sdk.accountFromPrivateKey(sdk.generatePrivateKey());
const [miner, artist, staff, alice, bob] = [account(), account(), account(), account(), account()];

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

async function api(node, path, chain = CHAIN) {
  const url = new URL(path, node.url);
  url.searchParams.set("chainPath", chain.join("/"));
  const response = await fetch(url, { cache: "no-store" });
  return response.ok ? response.json() : undefined;
}
const accountState = (node, who, chain = CHAIN) => api(node, `/api/state/account/${who.address}`, chain);
const balance = async (who, chain = CHAIN, node = fanNode) => BigInt((await accountState(node, who, chain))?.balance ?? 0);

const volumes = (node) => new sdk.VolumeClient(new sdk.HTTPVolumeTransport(`${node.url}/volumes`, { chainPath: CHAIN }));
/** The artist chain's state at a node's tip, read through the client. */
async function state(node = fanNode) {
  const client = volumes(node);
  const { generalStateCID } = await tip(sdk, node.url, CHAIN, client);
  return view(volumeLoader(client, sdk.decodeDagCbor), generalStateCID);
}

/**
 * What the wallet does with a `writeRecords` request from Fanfare: reads the
 * account's nonce from its node, builds the body (the same one write.mjs
 * `transaction` builds; checked against the wallet's own code), signs and
 * submits. Resolves to `{ ok, text }`.
 */
async function walletWrite(who, write_, node = fanNode) {
  const request = wallet.writeRequest(CHAIN, write_);
  const body = write.transaction({
    owner: who.address,
    actions: request.actions,
    payments: (request.payments ?? []).map(({ to, amount }) => ({ to, amount: BigInt(amount) })),
    fee: BigInt(request.fee),
    nonce: BigInt((await accountState(node, who))?.nonce ?? 0),
    chainPath: request.chainPath,
  });
  const { publicKey, signature } = sdk.signTransactionBody(body, who.privateKey);
  const response = await fetch(new URL("/transactions", node.url), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(sdk.transactionPayload({ [publicKey]: signature }, body)),
  });
  return { ok: response.ok, text: await response.text() };
}

/** Sends `write_` by `who` and waits until `landed` reads true on the fan's node. */
async function lands(label, who, write_, landed, node = fanNode) {
  const result = await walletWrite(who, write_, node);
  assert.ok(result.ok, `${label}: ${result.text}`);
  await until(label, landed);
}

/** The same key the stand-in wallet signs with, as `window.lattice.signMessage` on Fanfare's page. */
function walletOf(who) {
  const pkcs8 = new Uint8Array([...sdk.hexToBytes("302e020100300506032b657004220420"), ...who.privateKey]);
  return {
    async signMessage({ text }) {
      const key = await crypto.subtle.importKey("pkcs8", pkcs8, "Ed25519", false, ["sign"]);
      const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", key, door.signedBytes(ORIGIN, text)));
      return { publicKey: who.publicKey, signature: sdk.bytesToHex(signature) };
    },
  };
}

/** `lattice tx` on `node`, standing in for the wallet's market legs. */
function tx(leg, chain, who, args, node = fanNode) {
  const file = `${node.root}/${who.address}.key`;
  writeFileSync(file, JSON.stringify({ address: who.address, privateKey: Buffer.from(who.privateKey).toString("hex"), publicKey: who.publicKey }));
  chmodSync(file, 0o600);
  return node.lattice("tx", leg, "--chain", chain.join("/"), "--key", file, "--fee", "1", ...args);
}

const SHOW = "berlin";
const ticketOf = async (id) => read.ticket(await state(), artist.address, id);

try {
  // The artist's node: Nexus, the home chain and the artist chain.
  artistNode.lattice("init");
  artistNode.configure((topology) => {
    const { listen, rpc, publicRead } = artistNode;
    Object.assign(topology, { listen, rpc, publicRead, webSocket: 0, publicSubmit: true });
    topology.publicReadExpensiveRate = 1000;
    topology.peers = [];
    topology.mine = { worker: "cpu", workers: 1, batchSize: 100000 };
  });
  artistNode.lattice("child", "create", launch.HOME.join("/"));
  const specFile = `${artistNode.root}/band.json`;
  writeFileSync(specFile, JSON.stringify(launch.spec()));
  artistNode.lattice(...launch.createArguments({ name: "band", specFile, moduleFile: MODULE, artist: artist.address }));
  artistNode.configure((topology) => {
    topology.mine.recipients = { [launch.HOME.join("/")]: miner.address, [CHAIN.join("/")]: miner.address };
  });
  artistNode.lattice("up");
  artistNode.lattice("mine", "start");
  const premine = launch.premineAmount(launch.spec());
  await until("the artist chain's genesis", async () => (await balance(artist, CHAIN, artistNode)) === premine);
  console.log(`the artist launched ${CHAIN.join("/")}; its genesis paid them ${premine}`);

  // A fan's node: peers with the artist's, hosts the home chain, then joins
  // the artist chain while running.
  fanNode.lattice("init");
  fanNode.configure((topology) => {
    const { listen, rpc, publicRead } = fanNode;
    Object.assign(topology, { listen, rpc, publicRead, webSocket: 0, publicSubmit: true, hostedChains: [launch.HOME.join("/")] });
    topology.publicReadExpensiveRate = 1000;
    const identity = artistNode.lattice("identity").match(/([0-9a-f]{64})@/)[1];
    topology.peers = [`${identity}@127.0.0.1:${artistNode.listen}`];
  });
  fanNode.lattice("up");
  await until("the fan's node follows the home chain", async () => (await api(fanNode, "/api/block/latest", launch.HOME))?.hash);
  fanNode.configure((topology) => topology.hostedChains.push(CHAIN.join("/")));
  fanNode.lattice("up");
  const found = await until("the fan's node serves the artist chain", () => premineRecipient(sdk, fanNode.url, CHAIN, volumes(fanNode)));
  assert.equal(found, artist.address);
  {
    const client = volumes(fanNode);
    assert.ok(read.runsFanfare(await chainSpec(sdk, client, (await tip(sdk, fanNode.url, CHAIN, client)).specCID)));
  }
  console.log("a fan's node joined the artist chain while running; from it the client finds the artist in the genesis and the Fanfare policy in the spec");

  // The artist sets up from their own node: a show, a Q&A, a shirt, staff.
  const artistKey = await ship.artistKey(walletOf(artist));
  await lands("the artist's setup", artist, {
    actions: await write.changes(await state(artistNode), [
      ...write.listing(artist.address, SHOW, { kind: "ticket", title: "Berlin", venue: "Tresor", date: "2026-12-01" }),
      ...write.mint(artist.address, `${SHOW}/A1`, { price: 250n }),
      ...write.mint(artist.address, `${SHOW}/A2`, { price: 250n }),
      ...write.listing(artist.address, "qa", { kind: "qa", title: "Ask me anything" }),
      ...write.mint(artist.address, "qa/1", { price: 100n }),
      ...write.listing(artist.address, "shirt", { kind: "merch", title: "Tour shirt" }),
      ...write.mint(artist.address, "shirt/1", { price: 30n }),
      ...write.staff(artist.address, staff.address),
    ]),
    payments: [{ to: bob.address, amount: 1000n }, { to: staff.address, amount: 10n }],
  }, async () => (await ticketOf("shirt/1"))?.price === 30n, artistNode);
  console.log("the artist listed a show, a Q&A and a shirt, named door staff, and sent Bob 1000 band and staff 10 for fees");

  // Alice buys the artist's coin with Fanfare coin, through the fan's node.
  const [coin, asked, swap] = [5000n, 300n, ["--swap-nonce", "1", "--demand", "300"]];
  await until("the miner holds Fanfare coin", async () => (await balance(miner, launch.HOME)) > 1000n);
  tx("send", launch.HOME, miner, ["--to", alice.address, "--amount", "1000"]);
  await until("Alice holds Fanfare coin", async () => (await balance(alice, launch.HOME)) === 1000n);
  tx("deposit", CHAIN, artist, [...swap, "--lock", String(coin)], artistNode);
  const [offer] = await until("the offer is listed on the fan's node", async () => {
    const offers = await market.offers(fanNode.url, CHAIN);
    return offers.length > 0 && offers;
  });
  const { offers: taken } = market.pick([offer], 1000n);
  assert.ok(market.buyRequest(CHAIN, taken).startsWith("lattice://order?v=1&intent="));
  tx("receipt", launch.HOME, alice, [...swap, "--demander", artist.address, "--directory", CHAIN.at(-1)]);
  await until("the receipt", async () => (await balance(alice, launch.HOME)) === 1000n - asked - 1n);
  tx("withdraw", CHAIN, alice, [...swap, "--demander", artist.address, "--amount", String(coin)]);
  await until("Alice holds band", async () => (await balance(alice)) === coin - 1n);
  console.log(`Alice bought ${coin} band for ${asked} Fanfare coin on the market`);

  // Alice and Bob both go for A1; Bob read it before Alice's purchase landed.
  const a1 = await ticketOf(`${SHOW}/A1`);
  await lands("Alice buys A1", alice, write.buy(a1, alice.address), async () => (await ticketOf(`${SHOW}/A1`))?.holder === alice.address);
  const late = write.buy(a1, bob.address);
  const refused = await walletWrite(bob, late);
  assert.ok(!refused.ok, "Bob's purchase of a sold ticket was admitted");
  const why = await explain(await state(), late, bob.address, { balance: await balance(bob) });
  assert.deepEqual(why.map((w) => w.reason), ["sold"]);
  console.log(`Alice bought A1; Bob's late try was refused (${refused.text.trim()}) and the client told him: "${why[0].text}"`);

  // Alice resells A1 at her own price; Bob buys it alone.
  await lands("Alice prices A1 at 400", alice, { actions: [write.price(await ticketOf(`${SHOW}/A1`), 400n)] },
    async () => (await ticketOf(`${SHOW}/A1`))?.price === 400n);
  const aliceBefore = await balance(alice);
  await lands("Bob buys A1 from Alice", bob, write.buy(await ticketOf(`${SHOW}/A1`), bob.address),
    async () => (await ticketOf(`${SHOW}/A1`))?.holder === bob.address);
  assert.equal(await balance(alice), aliceBefore + 400n);
  console.log("Alice resold A1 to Bob at 400; she was paid in the same transaction");

  // Q&A: Alice buys the slot and asks in one write; the artist answers.
  const slot = await ticketOf("qa/1");
  const ask = write.buy(slot, alice.address);
  ask.actions.push(...(await write.changes(await state(), write.question(alice.address, artist.address, "qa/1", "What's the next album called?"))));
  await lands("Alice asks", alice, ask, async () => (await read.questions(await state(), artist.address, "qa")).length === 1);
  await lands("the artist answers", artist, { actions: await write.changes(await state(artistNode), write.answer(artist.address, "qa/1", "Fanfare.")) },
    async () => (await read.questions(await state(), artist.address, "qa"))[0]?.answer === "Fanfare.", artistNode);
  console.log("Alice paid 100 for a question; the artist answered it");

  // Merch: Alice buys the shirt and leaves an address sealed to the artist.
  const address = { name: "Alice", line1: "1 Main St", city: "Berlin", country: "DE" };
  const shirt = write.buy(await ticketOf("shirt/1"), alice.address);
  shirt.actions.push(...(await write.changes(await state(), write.ship(alice.address, artist.address, "shirt/1", await ship.seal(artistKey.publicKey, address)))));
  await lands("Alice buys the shirt", alice, shirt, async () => (await read.shipments(await state(), artist.address, "shirt")).length === 1);
  const [shipment] = await read.shipments(await state(artistNode), artist.address, "shirt");
  assert.ok(!shipment.sealed.includes("Main St"));
  assert.deepEqual(await ship.open((await ship.artistKey(walletOf(artist))).privateKey, shipment.sealed), address);
  console.log("Alice bought the shirt; only the artist's wallet opens her address");

  // The door: Bob answers the challenge for A1 with his wallet; Alice can't.
  const challenge = door.challenge(artist.address, `${SHOW}/A1`);
  const ticket = await ticketOf(`${SHOW}/A1`);
  assert.ok(await door.verify(sdk, ORIGIN, challenge, await door.prove(walletOf(bob), challenge), ticket));
  assert.ok(!(await door.verify(sdk, ORIGIN, challenge, await door.prove(walletOf(alice), challenge), ticket)));
  await lands("staff checks Bob in", staff, { actions: await write.changes(await state(), write.checkin(staff.address, artist.address, `${SHOW}/A1`)) },
    async () => (await read.checkins(await state(), artist.address, `${SHOW}/A1`)).length === 1);
  assert.deepEqual(await read.checkins(await state(), artist.address, `${SHOW}/A1`), [staff.address]);
  console.log("at the door Bob's wallet answered the challenge, Alice's didn't, and staff checked him in");

  assert.deepEqual((await read.held(await state(), artist.address, alice.address)).map((t) => t.id), ["qa/1", "shirt/1"]);
  assert.deepEqual((await read.held(await state(), artist.address, bob.address)).map((t) => t.id), [`${SHOW}/A1`]);
  console.log("the journey reads back the same from the fan's node");
} finally {
  for (const node of [fanNode, artistNode]) {
    try { node.lattice("mine", "stop"); } catch {}
    try { node.lattice("down"); } catch {}
  }
}
