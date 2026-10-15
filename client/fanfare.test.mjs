//   (cd policy && cargo build --release --target wasm32-unknown-unknown)
//   LATTICE_SDK=<lattice-sdk>/packages/sdk/dist/index.js node --test client/
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { context, validate } from "../policy/test/host.mjs";
import * as door from "./door.mjs";
import * as launch from "./launch.mjs";
import * as read from "./read.mjs";
import * as write from "./write.mjs";

const sdk = await import(process.env.LATTICE_SDK);
const PATH = ["Nexus", "fanfare", "band"];
const [ARTIST, ALICE, BOB, CAROL, STAFF] = ["artist", "alice", "bob", "carol", "staff"];

/**
 * A chain in memory that admits a transaction the way consensus would: every
 * action's old value must be what the key holds, the built Fanfare policy
 * must accept the body, and no balance may go below zero.
 */
function chain(balances) {
  const map = new Map();
  const coins = new Map(Object.entries(balances).map(([who, amount]) => [who, BigInt(amount)]));
  const state = {
    get: async (key) => map.get(key),
    async *list(prefix) {
      for (const key of [...map.keys()].sort()) if (key.startsWith(prefix)) yield [key, map.get(key)];
    },
  };
  let nonce = 0n;
  function submit(owner, actions, payments = []) {
    const body = write.transaction({ owner, actions, payments, fee: 1n, nonce: nonce++, chainPath: PATH });
    for (const { key, oldValue } of actions) if (map.get(key) !== oldValue) return false;
    if (!validate(context(sdk.encodeTransactionBody(body).bytes, { path: PATH }))) return false;
    const after = new Map(coins);
    for (const { owner: who, delta } of body.accountActions) after.set(who, (after.get(who) ?? 0n) + delta);
    if ([...after.values()].some((amount) => amount < 0n)) return false;
    for (const [who, amount] of after) coins.set(who, amount);
    for (const { key, newValue } of actions) {
      if (newValue === undefined) map.delete(key);
      else map.set(key, newValue);
    }
    return true;
  }
  return {
    state,
    balance: (who) => coins.get(who) ?? 0n,
    submit,
    /** Writes `[key, value]` pairs by `owner`, against the current state. */
    write: async (owner, writes) => submit(owner, await write.changes(state, writes)),
  };
}

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

test("a paid question: the slot's holder asks, the artist answers", async () => {
  const c = await show();
  assert.ok(
    await c.write(ARTIST, [
      ...write.listing(ARTIST, "qa-oct", { kind: "qa", title: "Ask me anything" }),
      ...write.mint(ARTIST, "qa-oct/1", { price: 50n }),
      ...write.mint(ARTIST, "qa-oct/2", { price: 50n }),
    ]),
  );
  assert.ok(c.submit(ALICE, ...Object.values(write.buy(await read.ticket(c.state, ARTIST, "qa-oct/1"), ALICE))));
  assert.ok(await c.write(ALICE, write.question(ALICE, ARTIST, "qa-oct/1", "First gig?")));
  // A question on a slot the asker doesn't hold doesn't count.
  assert.ok(await c.write(BOB, write.question(BOB, ARTIST, "qa-oct/2", "Free question?")));
  assert.deepEqual(
    (await read.questions(c.state, ARTIST, "qa-oct")).map(({ ticket, text, answer }) => [ticket.id, text, answer]),
    [["qa-oct/1", "First gig?", undefined]],
  );
  assert.ok(await c.write(ARTIST, write.answer(ARTIST, "qa-oct/1", "A basement in Leipzig.")));
  assert.equal((await read.questions(c.state, ARTIST, "qa-oct"))[0].answer, "A basement in Leipzig.");
  assert.equal((await read.listing(c.state, ARTIST, "qa-oct")).kind, "qa");
});

test("the door: the holder answers a challenge and trusted staff check in", async () => {
  const c = await show();
  const fan = sdk.accountFromPrivateKey(sdk.generatePrivateKey());
  const other = sdk.accountFromPrivateKey(sdk.generatePrivateKey());
  assert.ok(c.submit(CAROL, [write.transfer(await read.ticket(c.state, ARTIST, "berlin/guest"), fan.address)]));
  const ticket = await read.ticket(c.state, ARTIST, "berlin/guest");

  const text = door.challenge(ARTIST, ticket.id);
  assert.ok(door.verify(sdk, text, door.prove(sdk, text, fan.privateKey), ticket));
  assert.ok(!door.verify(sdk, text, door.prove(sdk, text, other.privateKey), ticket), "not the holder");
  const old = door.prove(sdk, door.challenge(ARTIST, ticket.id), fan.privateKey);
  assert.ok(!door.verify(sdk, text, old, ticket), "an answer to another challenge");
  assert.ok(!door.verify(sdk, text, { publicKey: "zz", signature: "00" }, ticket));

  assert.ok(await c.write(ARTIST, write.staff(ARTIST, STAFF)));
  assert.ok(await c.write(STAFF, write.checkin(STAFF, ARTIST, ticket.id)));
  assert.ok(await c.write(BOB, write.checkin(BOB, ARTIST, ticket.id)));
  assert.ok(!(await c.write(BOB, write.checkin(STAFF, ARTIST, ticket.id))), "only staff write their own check-in");
  assert.deepEqual(await read.checkins(c.state, ARTIST, ticket.id), [STAFF]);
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
