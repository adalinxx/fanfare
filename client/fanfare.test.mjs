//   (cd policy && cargo build --release --target wasm32-unknown-unknown)
//   LATTICE_SDK=<lattice-sdk>/packages/sdk/dist/index.js node --test client/
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as door from "./door.mjs";
import * as launch from "./launch.mjs";
import * as read from "./read.mjs";
import * as wallet from "./wallet.mjs";
import * as write from "./write.mjs";
import { chain as inMemory } from "./test-chain.mjs";

const sdk = await import(process.env.LATTICE_SDK);
const PATH = ["Nexus", "fanfare", "band"];
const [ARTIST, ALICE, BOB, CAROL, STAFF] = ["artist", "alice", "bob", "carol", "staff"];

/**
 * A stand-in for `window.lattice` on a page at `origin`: signs as the wallet
 * does, "lattice-message:" + origin + "\n" + text, with `who`'s key.
 */
function walletOf(who, origin) {
  // An Ed25519 seed as PKCS#8, the form WebCrypto imports.
  const pkcs8 = new Uint8Array([...sdk.hexToBytes("302e020100300506032b657004220420"), ...who.privateKey]);
  return {
    async signMessage({ text }) {
      const key = await crypto.subtle.importKey("pkcs8", pkcs8, "Ed25519", false, ["sign"]);
      const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", key, door.signedBytes(origin, text)));
      return { publicKey: who.publicKey, signature: sdk.bytesToHex(signature) };
    },
  };
}

const chain = (balances) => inMemory(sdk, PATH, balances);

async function show() {
  const c = chain({ [ARTIST]: 101, [ALICE]: 2000, [BOB]: 2000, [CAROL]: 2000, [STAFF]: 10 });
  assert.ok(
    await c.write(ARTIST, [
      ...write.listing(ARTIST, "berlin", { kind: "ticket", title: "Berlin", venue: "Tresor" }),
      ...write.mint(ARTIST, "berlin/A1", { price: 250n }),
      ...write.mint(ARTIST, "berlin/A2", { price: 250n }),
      ...write.mint(ARTIST, "berlin/A3", { price: 250n }),
      ...write.mint(ARTIST, "berlin/guest", { to: CAROL }),
    ]),
  );
  assert.equal(c.balance(ARTIST), 100n);
  return c;
}

test("the spec in chain/ runs the Fanfare policy, and a different one is custom", () => {
  const spec = JSON.parse(readFileSync(new URL("../chain/spec.json", import.meta.url)));
  assert.ok(read.runsFanfare(spec));
  const custom = { ...spec, wasmPolicies: [{ ...spec.wasmPolicies[0], moduleCID: "bafyreiother" }] };
  assert.ok(!read.runsFanfare(custom));
  assert.ok(!read.runsFanfare({ ...spec, wasmPolicies: [] }));
  assert.ok(!read.runsFanfare(undefined));
});

test("an artist lists a show and mints its tickets", async () => {
  const { state } = await show();
  assert.deepEqual(await read.listings(state, ARTIST), [
    { artist: ARTIST, name: "berlin", kind: "ticket", title: "Berlin", venue: "Tresor", closed: false },
  ]);
  const tickets = await read.tickets(state, ARTIST, "berlin");
  assert.deepEqual(
    tickets.map(({ id, holder, price }) => [id, holder, price]),
    [
      ["berlin/A1", ARTIST, 250n],
      ["berlin/A2", ARTIST, 250n],
      ["berlin/A3", ARTIST, 250n],
      ["berlin/guest", CAROL, undefined],
    ],
  );
});

test("a fan buys a ticket alone, and the artist is paid its price", async () => {
  const c = await show();
  const ticket = await read.ticket(c.state, ARTIST, "berlin/A1");
  const { actions, payments } = write.buy(ticket, ALICE);
  assert.ok(c.submit(ALICE, actions, payments));
  assert.equal(c.balance(ARTIST), 100n + 250n);
  assert.equal(c.balance(ALICE), 2000n - 251n);
  assert.equal((await read.ticket(c.state, ARTIST, "berlin/A1")).holder, ALICE);
  // A second buyer who read the ticket before the sale is refused.
  assert.ok(!c.submit(BOB, ...Object.values(write.buy(ticket, BOB))));
});

test("a buyer who saw an old price is refused when the holder changes it", async () => {
  const c = await show();
  const seen = await read.ticket(c.state, ARTIST, "berlin/A2");
  assert.ok(c.submit(ARTIST, [write.price(seen, 300n)]));
  const { actions, payments } = write.buy(seen, ALICE);
  assert.ok(!c.submit(ALICE, actions, payments));
  // Underpaying the new price is refused by the policy too.
  const now = await read.ticket(c.state, ARTIST, "berlin/A2");
  assert.ok(!c.submit(ALICE, write.buy(now, ALICE).actions, [{ to: ARTIST, amount: 250n }]));
  assert.ok(c.submit(ALICE, ...Object.values(write.buy(now, ALICE))));
  assert.equal(c.balance(ARTIST), 100n - 1n + 300n);
});

test("one transaction buys several tickets from one holder", async () => {
  const c = await show();
  const tickets = (await read.tickets(c.state, ARTIST, "berlin")).filter((t) => t.price !== undefined);
  const buys = tickets.map((t) => write.buy(t, BOB));
  assert.ok(c.submit(BOB, buys.flatMap((b) => b.actions), buys.flatMap((b) => b.payments)));
  assert.equal(c.balance(ARTIST), 100n + 750n);
  // Paying for one but taking two is refused.
  const d = await show();
  const again = (await read.tickets(d.state, ARTIST, "berlin")).filter((t) => t.price !== undefined).slice(0, 2);
  assert.ok(!d.submit(BOB, again.flatMap((t) => write.buy(t, BOB).actions), [{ to: ARTIST, amount: 250n }]));
});

test("the wallet request pays each holder once, the same body the chain admits", async () => {
  const c = await show();
  const tickets = (await read.tickets(c.state, ARTIST, "berlin")).filter((t) => t.price !== undefined);
  const buys = tickets.map((t) => write.buy(t, BOB));
  const request = wallet.writeRequest(PATH, { actions: buys.flatMap((b) => b.actions), payments: buys.flatMap((b) => b.payments) });
  assert.deepEqual(request.payments, [{ to: ARTIST, amount: "750" }]);
  assert.equal(request.fee, "1");
  assert.deepEqual(request.chainPath, PATH);
  assert.equal(wallet.writeRequest(PATH, { actions: request.actions }).payments, undefined);
  assert.throws(() => wallet.writeRequest(PATH, { actions: [] }));
  let asked;
  assert.deepEqual(await wallet.send({ writeRecords: async (r) => ((asked = r), { transactionCID: "bafy…" }) }, PATH, buys[0]), { transactionCID: "bafy…" });
  assert.deepEqual(asked.payments, [{ to: ARTIST, amount: "250" }]);
});

test("a holder resells at their own price, transfers, and the artist can't take it back", async () => {
  const c = await show();
  assert.ok(c.submit(ALICE, ...Object.values(write.buy(await read.ticket(c.state, ARTIST, "berlin/A1"), ALICE))));
  const mine = await read.ticket(c.state, ARTIST, "berlin/A1");
  assert.ok(!c.submit(BOB, [write.price(mine, 1n)]), "only the holder prices it");
  assert.ok(c.submit(ALICE, [write.price(mine, 400n)]));
  const before = c.balance(ALICE);
  assert.ok(c.submit(BOB, ...Object.values(write.buy(await read.ticket(c.state, ARTIST, "berlin/A1"), BOB))));
  assert.equal(c.balance(ALICE), before + 400n);

  const bobs = await read.ticket(c.state, ARTIST, "berlin/A1");
  assert.ok(c.submit(BOB, [write.transfer(bobs, CAROL)]));
  assert.deepEqual(
    (await read.held(c.state, ARTIST, CAROL)).map((t) => t.id),
    ["berlin/A1", "berlin/guest"],
  );
  assert.deepEqual(await read.held(c.state, ARTIST, BOB), []);

  // The artist can neither take a sold ticket back nor mint over it.
  const carols = await read.ticket(c.state, ARTIST, "berlin/A1");
  assert.ok(!c.submit(ARTIST, [write.transfer(carols, ARTIST)]));
  assert.ok(!(await c.write(ARTIST, write.mint(ARTIST, "berlin/A1", { price: 1n }))));
  // Nor can a fan mint for the show.
  assert.ok(!(await c.write(ALICE, write.mint(ARTIST, "berlin/A9"))));
});

test("closing a listing and taking unsold tickets off sale", async () => {
  const c = await show();
  const value = { kind: "ticket", title: "Berlin", venue: "Tresor", closed: true };
  const unsold = (await read.tickets(c.state, ARTIST, "berlin")).filter((t) => t.holder === ARTIST);
  const actions = [...(await write.changes(c.state, write.listing(ARTIST, "berlin", value))), ...unsold.map((t) => write.price(t))];
  assert.ok(c.submit(ARTIST, actions));
  assert.equal((await read.listing(c.state, ARTIST, "berlin")).closed, true);
  assert.ok((await read.tickets(c.state, ARTIST, "berlin")).every((t) => t.price === undefined));
  // A listing is never deleted.
  assert.ok(!(await c.write(ARTIST, write.listing(ARTIST, "berlin", undefined))));
});

test("the door: the holder's pass gets them in once, and only trusted staff check in", async () => {
  const c = await show();
  const fan = sdk.accountFromPrivateKey(sdk.generatePrivateKey());
  const other = sdk.accountFromPrivateKey(sdk.generatePrivateKey());
  assert.ok(c.submit(CAROL, [write.transfer(await read.ticket(c.state, ARTIST, "berlin/guest"), fan.address)]));
  const ticket = await read.ticket(c.state, ARTIST, "berlin/guest");

  const ORIGIN = "https://fanfare.example";
  const CHAIN = "Nexus/fanfare";
  const passOf = async (who, { origin = ORIGIN, chain = CHAIN, id = ticket.id } = {}) =>
    door.readPass(await door.pass(walletOf(who, origin), origin, chain, ARTIST, id));
  const berlin = await read.listing(c.state, ARTIST, "berlin");
  const verdict = async (scanned, listing = berlin, held = ticket) => (await door.check(sdk, [ORIGIN], CHAIN, scanned, listing, held, [])).reason;
  assert.deepEqual(await door.check(sdk, [ORIGIN], CHAIN, await passOf(fan), berlin, ticket, []), { ok: true });
  assert.equal(await verdict(await passOf(other)), "not-holder");
  assert.equal(await verdict(await passOf(fan, { chain: "Nexus/fanfare/band" })), "no-ticket", "a pass for another chain's ticket");
  assert.equal(await verdict(await passOf(fan, { origin: "https://other.example" })), "site", "made on another site");
  // A pass that claims Fanfare's origin but was signed for another site doesn't verify.
  const elsewhere = await passOf(fan, { origin: "https://other.example" });
  assert.equal(await verdict({ ...elsewhere, origin: ORIGIN }), "not-holder");
  // The ticket is for Berlin, not for another show or a Q&A.
  assert.ok(await c.write(ARTIST, write.listing(ARTIST, "paris", { kind: "ticket", title: "Paris" })));
  assert.equal(await verdict(await passOf(fan), await read.listing(c.state, ARTIST, "paris")), "other-show");
  assert.equal(await verdict(await passOf(fan), { ...berlin, kind: "other" }), "other-show");
  assert.ok(door.inListing("berlin", "berlin") && door.inListing("berlin", "berlin/A1") && !door.inListing("berlin", "berlin-2/A1"));
  // A listing named inside another's tickets isn't a listing Fanfare shows, so no door is opened for it.
  assert.ok(await c.write(ARTIST, write.listing(ARTIST, "berlin/late", { kind: "ticket", title: "Late show" })));
  assert.equal(await read.listing(c.state, ARTIST, "berlin/late"), undefined);
  assert.ok(!(await read.listings(c.state, ARTIST)).some((l) => l.name.includes("/")));
  assert.equal(await verdict(await passOf(fan, { id: "berlin/A1" })), "no-ticket", "a pass for another ticket");
  const scanned = await passOf(fan);
  const text = door.passText(CHAIN, ARTIST, ticket.id);
  const transactionSignature = { publicKey: fan.publicKey, signature: sdk.signPreimage(text, fan.privateKey) };
  assert.equal(await verdict({ ...scanned, proof: transactionSignature }), "not-holder", "a transaction-domain signature");
  assert.equal(await verdict({ ...scanned, proof: { publicKey: "zz", signature: "00" } }), "not-holder");
  assert.equal((await door.check(sdk, [ORIGIN], CHAIN, scanned, berlin, ticket, ["staff"])).reason, "used");
  // A pass has no time limit, but it stops working once the ticket is sold or given away.
  // The door reads the holder from state at the scan; here, as it reads after a sale to `other`.
  const resold = { ...ticket, holder: other.address, value: other.address };
  assert.equal(await verdict(scanned, berlin, resold), "not-holder", "the seller's old pass");
  assert.equal(await verdict(await passOf(other), berlin, resold), undefined, "the buyer's pass");
  assert.equal(door.readPass("hello"), undefined);
  assert.equal(door.readPass('fanfare-pass:{"a":"x"}'), undefined);

  assert.ok(await c.write(ARTIST, write.staff(ARTIST, STAFF)));
  assert.ok(await c.write(STAFF, write.checkin(STAFF, ARTIST, ticket.id)));
  assert.ok(await c.write(BOB, write.checkin(BOB, ARTIST, ticket.id)));
  assert.ok(!(await c.write(BOB, write.checkin(STAFF, ARTIST, ticket.id))), "only staff write their own check-in");
  assert.deepEqual(await read.checkins(c.state, ARTIST, ticket.id), [STAFF]);
  assert.deepEqual([...(await read.checkedIn(c.state, ARTIST, "berlin"))], [ticket.id], "Bob's own check-in doesn't count");
  // A check-in on berlin/guest/x is not one on berlin/guest.
  assert.ok(await c.write(STAFF, write.checkin(STAFF, ARTIST, `${ticket.id}/x`)));
  assert.deepEqual(await read.checkins(c.state, ARTIST, ticket.id), [STAFF]);
});

test("ticket values parse as the policy reads them", () => {
  assert.deepEqual(read.holding("a"), { holder: "a" });
  assert.deepEqual(read.holding("a@0"), { holder: "a", price: 0n });
  assert.deepEqual(read.holding("a@18446744073709551615"), { holder: "a", price: 2n ** 64n - 1n });
  for (const value of ["", "@5", "a@", "a@01", "a@-1", "a@1.5", "a@5@6", "a@18446744073709551616", undefined]) {
    assert.equal(read.holding(value), undefined, value);
  }
  assert.throws(() => write.holding("a", -1n));
  assert.throws(() => write.holding("a", 2n ** 64n));
  assert.throws(() => write.holding("a", 5));
});

test("the default artist spec is the one in chain/, and pays 21,000,000 at genesis", () => {
  const file = JSON.parse(readFileSync(new URL("../chain/spec.json", import.meta.url)));
  assert.deepEqual(launch.spec(), file);
  assert.ok(read.runsFanfare(launch.spec()));
  assert.equal(launch.premineAmount(launch.spec()), 21_000_000n);
  // Across a halving: 10 blocks of 10, then 5 of 5.
  assert.equal(launch.premineAmount({ premine: 15, initialReward: 10, halvingInterval: 10 }), 125n);
  assert.equal(launch.premineAmount(launch.spec({ premine: 0 })), 0n);
  assert.equal(launch.spec({ premine: 5 }).premine, 5);
});

test("an artist chain is created under the home chain with the premine to the artist", () => {
  assert.deepEqual(launch.createArguments({ name: "band", specFile: "s.json", moduleFile: "p.wasm", artist: ARTIST }), [
    "child", "create", "Nexus/fanfare/band", "--spec", "s.json", "--policy-module", "p.wasm", "--premine-to", ARTIST,
  ]);
  for (const name of ["", "a/b", undefined]) assert.throws(() => launch.chainPath(name));
});

test("the shared chain: every artist's listings, and every ticket a fan holds", async () => {
  const c = await show();
  assert.ok(await c.write(BOB, write.listing(BOB, "leipzig", { kind: "ticket", title: "Leipzig", price: "20" })));
  assert.deepEqual(
    (await read.allListings(c.state)).map((l) => [l.artist, l.name]).sort(),
    [[ARTIST, "berlin"], [BOB, "leipzig"]].sort(),
  );
  assert.ok(await c.write(BOB, write.mint(BOB, "leipzig/1", { to: ALICE })));
  assert.ok((await read.heldAll(c.state, ALICE)).some((t) => t.artist === BOB && t.id === "leipzig/1"));
});
