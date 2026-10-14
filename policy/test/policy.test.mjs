// Runs the built policy module the way the Lattice host does: allocate with
// `lattice_alloc`, write the canonical context, call the entrypoint. Bodies
// are encoded by the SDK, whose encoding is pinned to Lattice's vectors.
//
//   cargo build --release --target wasm32-unknown-unknown
//   LATTICE_SDK_CORE=<lattice-sdk>/packages/core/dist/index.js node --test test/policy.test.mjs
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";

const { encodeTransactionBody } = await import(process.env.LATTICE_SDK_CORE);
const module = new WebAssembly.Module(
  readFileSync(
    new URL("../target/wasm32-unknown-unknown/release/fanfare_policy.wasm", import.meta.url),
  ),
);

const ALICE = "alice-address";
const BOB = "bob-address";
const PATH = ["Nexus", "fanfare", "band"];

function u32(value) {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value);
  return bytes;
}

function u64(value) {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, value);
  return bytes;
}

function context(bodyBytes, { version = 2, height = 100n } = {}) {
  const text = new TextEncoder();
  const parts = [
    text.encode("LWPCTX"),
    Uint8Array.of(0, version, 0, 1, 0), // encoding version, ABI version, transaction scope
    u64(height),
    new Uint8Array(8), // timestamp
    u32(3),
    Uint8Array.of(0xa0, 0xa0, 0xa0), // stand-in chain spec bytes; the policy skips them
    u32(PATH.length),
    ...PATH.flatMap((segment) => [u32(text.encode(segment).length), text.encode(segment)]),
  ];
  if (bodyBytes === undefined) parts.push(Uint8Array.of(0));
  else parts.push(Uint8Array.of(1), u32(bodyBytes.length), bodyBytes);
  parts.push(Uint8Array.of(0, 0)); // no action, no action index
  return Uint8Array.from(parts.flatMap((part) => [...part]));
}

// With CONTEXT_DIR set, every context is recorded with its verdict so
// host-check can replay it through Lattice's own evaluator.
const contextDirectory = process.env.CONTEXT_DIR;
if (contextDirectory) mkdirSync(contextDirectory, { recursive: true });
let recorded = 0;

function run(bytes) {
  const { exports } = new WebAssembly.Instance(module);
  const pointer = exports.lattice_alloc(bytes.length);
  new Uint8Array(exports.memory.buffer).set(bytes, pointer);
  const accepted = exports.lattice_validate_transaction(pointer, bytes.length) === 1;
  if (contextDirectory) {
    const name = `${String(recorded++).padStart(3, "0")}-${accepted ? "accept" : "reject"}.bin`;
    writeFileSync(`${contextDirectory}/${name}`, bytes);
  }
  return accepted;
}

function body(actions, signers = [ALICE], extra = {}) {
  return encodeTransactionBody({
    accountActions: [],
    actions,
    depositActions: [],
    receiptActions: [],
    withdrawalActions: [],
    signers,
    nonce: 7n,
    chainPath: PATH,
    ...extra,
  }).bytes;
}

const accepts = (actions, signers, extra, options) =>
  run(context(body(actions, signers, extra), options));

test("an author writes, edits and deletes their own records", () => {
  assert.ok(accepts([{ key: `user/${ALICE}/note/7f3a`, newValue: "hello" }]));
  assert.ok(accepts([{ key: `user/${ALICE}/note/7f3a`, oldValue: "hello", newValue: "hello, world" }]));
  assert.ok(accepts([{ key: `user/${ALICE}/note/7f3a`, oldValue: "hello, world" }]));
  assert.ok(accepts([{ key: `user/${ALICE}/note/b21c`, newValue: "ciphertext" }]));
  assert.ok(accepts([{ key: `user/${ALICE}`, newValue: "x" }]));
  assert.ok(accepts([{ key: `user/${ALICE}/anything/a/client/invents`, newValue: "x" }]));
});

test("nobody writes or deletes another author's records", () => {
  assert.ok(!accepts([{ key: `user/${BOB}/note/7f3a`, newValue: "forged" }]));
  assert.ok(!accepts([{ key: `user/${BOB}/note/7f3a`, oldValue: "hello" }]));
  assert.ok(!accepts([{ key: `user/${BOB}/note/b21c`, newValue: "ciphertext" }]));
  // Naming yourself later in someone else's namespace does not make it yours.
  assert.ok(!accepts([{ key: `user/${BOB}/${ALICE}`, newValue: "x" }]));
  // One bad action rejects the whole transaction.
  assert.ok(
    !accepts([
      { key: `user/${ALICE}/note/7f3a`, newValue: "mine" },
      { key: `user/${BOB}/note/7f3a`, newValue: "not mine" },
    ]),
  );
});

test("an index entry belongs to the writer named in its last segment", () => {
  assert.ok(
    accepts([
      { key: `user/${ALICE}/note/7f3a`, newValue: "1" },
      { key: `index/topic/${BOB}/${ALICE}`, newValue: "1" },
      { key: `index/other/${BOB}/1/${ALICE}`, newValue: "1" },
      { key: `index/a/deeper/topic/${ALICE}`, newValue: "1" },
    ]),
  );
  assert.ok(!accepts([{ key: `index/topic/${ALICE}/${BOB}`, newValue: "1" }]));
  assert.ok(!accepts([{ key: `index/other/${ALICE}/1/${BOB}`, oldValue: "1" }]));
  // An index key needs a topic as well as an owner.
  assert.ok(!accepts([{ key: `index/${ALICE}`, newValue: "1" }]));
  assert.ok(!accepts([{ key: "index", newValue: "1" }]));
});

test("any one of several signers may own a key", () => {
  assert.ok(accepts([{ key: `user/${BOB}/note/7f3a`, newValue: "hi" }], [ALICE, BOB]));
});

test("keys outside the three shapes are rejected", () => {
  for (const key of [ALICE, `${ALICE}/note/7f3a`, `crm/${ALICE}/1`, "user", "user/", `users/${ALICE}`, `/user/${ALICE}`]) {
    assert.ok(!accepts([{ key, newValue: "x" }]), key);
  }
});

test("the policy puts no limit on key or value size", () => {
  assert.ok(accepts([{ key: `user/${ALICE}/${"i".repeat(5000)}`, newValue: "x".repeat(200000) }]));
});

test("coin actions pass untouched", () => {
  assert.ok(accepts([]));
  assert.ok(
    accepts([], [ALICE], {
      accountActions: [
        { owner: ALICE, delta: -1000n },
        { owner: BOB, delta: 998n },
      ],
      depositActions: [{ nonce: 1n, demander: ALICE, amountDemanded: 5n, amountDeposited: 5n }],
    }),
  );
});

test("a malformed or unknown context is rejected", () => {
  const good = body([{ key: `user/${ALICE}/note/7f3a`, newValue: "hello" }]);
  assert.ok(run(context(good)));
  assert.ok(!run(context(good, { version: 1 })));
  assert.ok(!run(context(undefined)));
  assert.ok(!run(context(good.slice(0, good.length - 3))));
  assert.ok(!run(context(good).slice(0, 40)));
  assert.ok(!run(new Uint8Array(0)));
});

// Tokens. ARTIST mints and sells; ALICE and BOB are fans.
const ARTIST = "artist-address";
const ITEM = "5.berlin-night-1"; // five tickets
const own = (serial, item = ITEM, seller = ARTIST) => `own/${seller}/${item}/${serial}`;
const pay = (from, to, amount) => [
  { owner: from, delta: -amount },
  { owner: to, delta: amount },
];
const signedBy = (signers, actions, accountActions = []) => accepts(actions, signers, { accountActions });

test("only the seller mints, below the supply", () => {
  assert.ok(signedBy([ARTIST], [{ key: own(0), newValue: ARTIST }]));
  assert.ok(signedBy([ARTIST], [{ key: own(4), newValue: `${ARTIST}@250` }]));
  // Minting straight to a fan is a comp.
  assert.ok(signedBy([ARTIST], [{ key: own(1), newValue: ALICE }]));
  assert.ok(!signedBy([ARTIST], [{ key: own(5), newValue: ARTIST }]));
  assert.ok(!signedBy([ARTIST], [{ key: own(0, "0.none"), newValue: ARTIST }]));
  // A fan can't mint the artist's tickets, even paying for them.
  assert.ok(!signedBy([ALICE], [{ key: own(0), newValue: ALICE }], pay(ALICE, ARTIST, 10n ** 6n)));
  assert.ok(!signedBy([ALICE], [{ key: own(0), newValue: `${ARTIST}@250` }]));
});

test("anyone takes a priced token by paying its holder", () => {
  const offered = `${ARTIST}@250`;
  assert.ok(signedBy([ALICE], [{ key: own(2), oldValue: offered, newValue: ALICE }], pay(ALICE, ARTIST, 250n)));
  // Paying more is fine; the buyer may name someone else, or price it again.
  assert.ok(signedBy([ALICE], [{ key: own(2), oldValue: offered, newValue: BOB }], pay(ALICE, ARTIST, 300n)));
  assert.ok(signedBy([ALICE], [{ key: own(2), oldValue: offered, newValue: `${ALICE}@900` }], pay(ALICE, ARTIST, 250n)));
  // A fan resells the same way.
  assert.ok(signedBy([BOB], [{ key: own(2), oldValue: `${ALICE}@400`, newValue: BOB }], pay(BOB, ALICE, 400n)));
  // A price of 0 is a giveaway.
  assert.ok(signedBy([BOB], [{ key: own(2), oldValue: `${ALICE}@0`, newValue: BOB }]));
});

test("a take that underpays, or pays someone else, is refused", () => {
  const offered = `${ARTIST}@250`;
  assert.ok(!signedBy([ALICE], [{ key: own(2), oldValue: offered, newValue: ALICE }], pay(ALICE, ARTIST, 249n)));
  assert.ok(!signedBy([ALICE], [{ key: own(2), oldValue: offered, newValue: ALICE }]));
  assert.ok(!signedBy([ALICE], [{ key: own(2), oldValue: offered, newValue: ALICE }], pay(ALICE, BOB, 250n)));
  // A debit from the holder is not a payment to them.
  assert.ok(!signedBy([ALICE], [{ key: own(2), oldValue: offered, newValue: ALICE }], [{ owner: ARTIST, delta: -250n }]));
});

test("a token without a price can't be taken", () => {
  assert.ok(!signedBy([BOB], [{ key: own(2), oldValue: ALICE, newValue: BOB }], pay(BOB, ALICE, 10n ** 6n)));
});

test("one payment covers one price, per holder", () => {
  const two = [
    { key: own(1), oldValue: `${ARTIST}@250`, newValue: ALICE },
    { key: own(2), oldValue: `${ARTIST}@250`, newValue: ALICE },
  ];
  assert.ok(!signedBy([ALICE], two, pay(ALICE, ARTIST, 250n)));
  assert.ok(signedBy([ALICE], two, pay(ALICE, ARTIST, 500n)));
  const twoHolders = [
    { key: own(1), oldValue: `${ARTIST}@250`, newValue: ALICE },
    { key: own(3), oldValue: `${BOB}@100`, newValue: ALICE },
  ];
  assert.ok(!signedBy([ALICE], twoHolders, pay(ALICE, ARTIST, 350n)));
  assert.ok(
    signedBy([ALICE], twoHolders, [{ owner: ALICE, delta: -350n }, { owner: ARTIST, delta: 250n }, { owner: BOB, delta: 100n }]),
  );
});

test("the holder transfers, prices and unprices a token, and nobody else can", () => {
  assert.ok(signedBy([ALICE], [{ key: own(3), oldValue: ALICE, newValue: BOB }]));
  assert.ok(signedBy([ALICE], [{ key: own(3), oldValue: ALICE, newValue: `${ALICE}@400` }]));
  assert.ok(signedBy([ALICE], [{ key: own(3), oldValue: `${ALICE}@400`, newValue: `${ALICE}@350` }]));
  assert.ok(signedBy([ALICE], [{ key: own(3), oldValue: `${ALICE}@400`, newValue: ALICE }]));
  assert.ok(!signedBy([BOB], [{ key: own(3), oldValue: ALICE, newValue: BOB }]));
  // The seller has no say once a token is sold.
  assert.ok(!signedBy([ARTIST], [{ key: own(3), oldValue: ALICE, newValue: ARTIST }]));
  // A transfer is not a mint: the supply doesn't apply to existing tokens' writes.
  assert.ok(!signedBy([BOB], [{ key: own(3), oldValue: `${ALICE}@400`, newValue: `${BOB}` }], pay(BOB, ALICE, 399n)));
});

test("a token is never deleted or left without a holder", () => {
  assert.ok(!signedBy([ALICE], [{ key: own(3), oldValue: ALICE }]));
  for (const newValue of ["", "@250", `${ALICE}@`, `${ALICE}@01`, `${ALICE}@-1`, `${ALICE}@1@2`]) {
    assert.ok(!signedBy([ALICE], [{ key: own(3), oldValue: ALICE, newValue }]), newValue);
  }
  assert.ok(!signedBy([ARTIST], [{ key: own(0), newValue: "" }]));
});

test("a malformed token key is refused", () => {
  for (const key of [
    `own/${ARTIST}/${ITEM}`,
    `own/${ARTIST}/${ITEM}/1/extra`,
    `own//${ITEM}/1`,
    `own/${ARTIST}/${ITEM}/01`, // one serial, one spelling
    `own/${ARTIST}/${ITEM}/-1`,
    `own/${ARTIST}/${ITEM}/18446744073709551616`,
    `own/${ARTIST}/5/1`, // no name
    `own/${ARTIST}/5./1`,
    `own/${ARTIST}/05.x/1`,
    `own/${ARTIST}/x.y/1`,
    "own",
  ]) {
    assert.ok(!signedBy([ARTIST], [{ key, newValue: ARTIST }]), key);
  }
  // A name may contain dots.
  assert.ok(signedBy([ARTIST], [{ key: own(0, "5.tour.2027"), newValue: ARTIST }]));
});

test("tokens mix with owned records in one transaction", () => {
  const take = { key: own(4), oldValue: `${ARTIST}@250`, newValue: ALICE };
  assert.ok(
    signedBy([ALICE], [take, { key: `user/${ALICE}/question/${ARTIST}/${ITEM}/4`, newValue: "What inspired the record?" }], pay(ALICE, ARTIST, 250n)),
  );
  assert.ok(
    !signedBy([ALICE], [take, { key: `user/${BOB}/question/${ARTIST}/${ITEM}/4`, newValue: "forged" }], pay(ALICE, ARTIST, 250n)),
  );
});

test("a seller lists, edits and closes an item, but never deletes it", () => {
  const listing = `item/${ARTIST}/${ITEM}`;
  assert.ok(signedBy([ARTIST], [{ key: listing, newValue: '{"title":"Berlin"}' }]));
  assert.ok(signedBy([ARTIST], [{ key: listing, oldValue: '{"title":"Berlin"}', newValue: '{"closed":true}' }]));
  assert.ok(!signedBy([ARTIST], [{ key: listing, oldValue: '{"closed":true}' }]));
  assert.ok(!signedBy([ALICE], [{ key: listing, newValue: "forged" }]));
  for (const key of [`item/${ARTIST}`, `item//${ITEM}`, `item/${ARTIST}/${ITEM}/1`, `item/${ARTIST}/5`, `item/${ARTIST}/05.x`]) {
    assert.ok(!signedBy([ARTIST], [{ key, newValue: "x" }]), key);
  }
});

test("door staff check in a ticket under their own key", () => {
  const STAFF = "staff-address";
  assert.ok(signedBy([ARTIST], [{ key: `user/${ARTIST}/staff/${STAFF}`, newValue: "door" }]));
  assert.ok(signedBy([STAFF], [{ key: `index/checkin/${ARTIST}/${ITEM}/4/${STAFF}`, newValue: "1" }]));
  assert.ok(!signedBy([ALICE], [{ key: `index/checkin/${ARTIST}/${ITEM}/4/${STAFF}`, newValue: "1" }]));
});
