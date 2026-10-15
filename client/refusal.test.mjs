// Every case first shows the write is really refused (by the policy, by a
// stale old value, or by the balance), then checks what the client says.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as read from "./read.mjs";
import { explain } from "./refusal.mjs";
import { chain } from "./test-chain.mjs";
import * as write from "./write.mjs";

const sdk = await import(process.env.LATTICE_SDK);
const PATH = ["Nexus", "fanfare", "band"];
const [ARTIST, ALICE, BOB] = ["artist", "alice", "bob"];

async function show() {
  const c = chain(sdk, PATH, { [ARTIST]: 100, [ALICE]: 2000, [BOB]: 2000 });
  assert.ok(
    await c.write(ARTIST, [
      ...write.listing(ARTIST, "berlin", { kind: "ticket", title: "Berlin" }),
      ...write.mint(ARTIST, "berlin/A1", { price: 250n }),
      ...write.mint(ARTIST, "berlin/A2", { price: 250n }),
    ]),
  );
  return c;
}
const seat = (c, id) => read.ticket(c.state, ARTIST, id);
const reasons = async (c, w, me, options) => (await explain(c.state, w, me, options)).map((r) => r.reason);

test("a ticket someone else bought first, or whose price changed", async () => {
  const c = await show();
  const seen = await seat(c, "berlin/A1");
  assert.ok(c.submit(BOB, ...Object.values(write.buy(seen, BOB))));
  const late = write.buy(seen, ALICE);
  assert.ok(!c.submit(ALICE, late.actions, late.payments));
  assert.deepEqual(await explain(c.state, late, ALICE), [
    { key: `own/${ARTIST}/berlin/A1`, reason: "sold", text: "Someone else bought this ticket first." },
  ]);
  // Bob's own write landed.
  assert.deepEqual(await reasons(c, write.buy(seen, BOB), BOB), ["done"]);

  const before = await seat(c, "berlin/A2");
  assert.ok(c.submit(ARTIST, [write.price(before, 300n)]));
  const stale = write.buy(before, ALICE);
  assert.ok(!c.submit(ALICE, stale.actions, stale.payments));
  assert.deepEqual((await explain(c.state, stale, ALICE))[0].text, "The price changed to 300.");
  assert.ok(c.submit(ARTIST, [write.price(await seat(c, "berlin/A2"))]));
  assert.ok(!c.submit(ALICE, stale.actions, stale.payments));
  assert.deepEqual(await reasons(c, stale, ALICE), ["off-sale"]);
});

test("what the policy refuses on a ticket that hasn't changed", async () => {
  const c = await show();
  const a1 = await seat(c, "berlin/A1");
  const under = { actions: write.buy(a1, ALICE).actions, payments: [{ to: ARTIST, amount: 249n }] };
  assert.ok(!c.submit(ALICE, under.actions, under.payments));
  assert.deepEqual(await reasons(c, under, ALICE), ["underpaid"]);

  const mint = { actions: await write.changes(c.state, write.mint(ARTIST, "berlin/A9", { to: ALICE })) };
  assert.ok(!c.submit(ALICE, mint.actions));
  assert.deepEqual(await reasons(c, mint, ALICE), ["not-artist"]);

  assert.ok(c.submit(ALICE, ...Object.values(write.buy(a1, ALICE))));
  const alices = await seat(c, "berlin/A1");
  const take = { actions: [write.transfer(alices, BOB)] };
  assert.ok(!c.submit(BOB, take.actions));
  assert.deepEqual(await reasons(c, take, BOB), ["not-for-sale"]);
  const burn = { actions: [{ key: read.ticketKey(ARTIST, "berlin/A1"), oldValue: alices.value }] };
  assert.ok(!c.submit(ALICE, burn.actions));
  assert.deepEqual(await reasons(c, burn, ALICE), ["permanent"]);
});

test("records owned by someone else, a deleted listing, and too little coin", async () => {
  const c = await show();
  const answer = { actions: await write.changes(c.state, write.answer(ARTIST, "qa/1", "hi")) };
  assert.ok(!c.submit(BOB, answer.actions));
  assert.deepEqual(await reasons(c, answer, BOB), ["not-yours"]);
  const checkin = { actions: await write.changes(c.state, write.checkin(ARTIST, ARTIST, "berlin/A1")) };
  assert.ok(!c.submit(BOB, checkin.actions));
  assert.deepEqual(await reasons(c, checkin, BOB), ["not-yours"]);

  const unlist = { actions: await write.changes(c.state, write.listing(ARTIST, "berlin", undefined)) };
  assert.ok(!c.submit(ARTIST, unlist.actions));
  assert.deepEqual(await reasons(c, unlist, ARTIST), ["permanent"]);

  const buy = write.buy(await seat(c, "berlin/A2"), ALICE);
  assert.deepEqual(await reasons(c, buy, ALICE, { balance: 250n }), ["funds"]);
  // Nothing in the way: the write may still land.
  assert.deepEqual(await explain(c.state, buy, ALICE, { balance: 251n }), []);
});
