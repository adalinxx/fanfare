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

// Tokens. ARTIST sells; ALICE and BOB are fans.
const ARTIST = "artist-address";
const ITEM = "250.800.0.berlin-night-1"; // price 250, supply 800, never closes
const own = (serial, item = ITEM, seller = ARTIST) => `own/${seller}/${item}/${serial}`;
const pay = (from, to, amount) => [
  { owner: from, delta: -amount },
  { owner: to, delta: amount },
];
const buy = (actions, { signers = [ALICE], accountActions = pay(ALICE, ARTIST, 250n), height } = {}) =>
  accepts(actions, signers, { accountActions }, { height });

test("a fan buys a token by paying the seller its price", () => {
  assert.ok(buy([{ key: own(0), newValue: ALICE }]));
  assert.ok(buy([{ key: own(799), newValue: ALICE }]));
  // Paying more than the price is a tip.
  assert.ok(buy([{ key: own(5), newValue: ALICE }], { accountActions: pay(ALICE, ARTIST, 1000n) }));
  // The first holder may be someone else: a gift.
  assert.ok(buy([{ key: own(5), newValue: BOB }]));
  // A free item needs no payment.
  assert.ok(buy([{ key: own(0, "0.100.0.rsvp"), newValue: ALICE }], { accountActions: [] }));
});

test("a buy that underpays, or pays someone else, is refused", () => {
  assert.ok(!buy([{ key: own(0), newValue: ALICE }], { accountActions: pay(ALICE, ARTIST, 249n) }));
  assert.ok(!buy([{ key: own(0), newValue: ALICE }], { accountActions: [] }));
  assert.ok(!buy([{ key: own(0), newValue: ALICE }], { accountActions: pay(ALICE, BOB, 250n) }));
  // A debit from the seller is not a payment to them.
  assert.ok(!buy([{ key: own(0), newValue: ALICE }], { accountActions: [{ owner: ARTIST, delta: -250n }] }));
});

test("one payment covers only one price", () => {
  const two = [
    { key: own(1), newValue: ALICE },
    { key: own(2), newValue: ALICE },
  ];
  assert.ok(!buy(two));
  assert.ok(buy(two, { accountActions: pay(ALICE, ARTIST, 500n) }));
  // Two credits to the seller add up.
  assert.ok(buy(two, { accountActions: [...pay(ALICE, ARTIST, 250n), { owner: ARTIST, delta: 250n }] }));
  // Different items from one seller add up too.
  const mixed = [
    { key: own(1), newValue: ALICE },
    { key: own(1, "40.50.0.tote"), newValue: ALICE },
  ];
  assert.ok(!buy(mixed));
  assert.ok(buy(mixed, { accountActions: pay(ALICE, ARTIST, 290n) }));
});

test("each seller is paid for their own tokens", () => {
  const OTHER = "other-artist";
  const both = [
    { key: own(1), newValue: ALICE },
    { key: own(1, ITEM, OTHER), newValue: ALICE },
  ];
  assert.ok(!buy(both, { accountActions: pay(ALICE, ARTIST, 500n) }));
  assert.ok(
    buy(both, {
      accountActions: [{ owner: ALICE, delta: -500n }, { owner: ARTIST, delta: 250n }, { owner: OTHER, delta: 250n }],
    }),
  );
});

test("a seller may comp a token by paying themselves", () => {
  assert.ok(buy([{ key: own(9), newValue: BOB }], { signers: [ARTIST], accountActions: pay(ARTIST, ARTIST, 250n) }));
});

test("the supply caps the serials", () => {
  assert.ok(!buy([{ key: own(800), newValue: ALICE }]));
  assert.ok(!buy([{ key: own(0, "250.0.0.none"), newValue: ALICE }]));
});

test("an item closes after its last block", () => {
  const closing = "250.800.500.presale";
  assert.ok(buy([{ key: own(0, closing), newValue: ALICE }], { height: 499n }));
  assert.ok(buy([{ key: own(0, closing), newValue: ALICE }], { height: 500n }));
  assert.ok(!buy([{ key: own(0, closing), newValue: ALICE }], { height: 501n }));
  // 0 never closes.
  assert.ok(buy([{ key: own(0), newValue: ALICE }], { height: 18446744073709551615n }));
});

test("the holder transfers a token, and nobody else can", () => {
  assert.ok(accepts([{ key: own(3), oldValue: ALICE, newValue: BOB }], [ALICE]));
  assert.ok(!accepts([{ key: own(3), oldValue: ALICE, newValue: BOB }], [BOB]));
  assert.ok(!accepts([{ key: own(3), oldValue: ALICE, newValue: ARTIST }], [ARTIST]));
  // A transfer is not a buy: no supply, closing or payment check.
  assert.ok(accepts([{ key: own(3, "250.800.5.presale"), oldValue: ALICE, newValue: BOB }], [ALICE], {}, { height: 900n }));
});

test("a resale moves the token and the payment in one transaction", () => {
  assert.ok(
    accepts([{ key: own(3), oldValue: ALICE, newValue: BOB }], [ALICE, BOB], { accountActions: pay(BOB, ALICE, 400n) }),
  );
});

test("a token is never deleted or left without a holder", () => {
  assert.ok(!accepts([{ key: own(3), oldValue: ALICE }], [ALICE]));
  assert.ok(!accepts([{ key: own(3), oldValue: ALICE, newValue: "" }], [ALICE]));
  assert.ok(!buy([{ key: own(3), newValue: "" }]));
});

test("a malformed token key is refused", () => {
  for (const key of [
    `own/${ARTIST}/${ITEM}`,
    `own/${ARTIST}/${ITEM}/1/extra`,
    `own//${ITEM}/1`,
    `own/${ARTIST}/${ITEM}/01`, // one serial, one spelling
    `own/${ARTIST}/${ITEM}/-1`,
    `own/${ARTIST}/${ITEM}/1.0`,
    `own/${ARTIST}/${ITEM}/18446744073709551616`,
    `own/${ARTIST}/250.800.0/1`, // no name
    `own/${ARTIST}/250.800.0./1`,
    `own/${ARTIST}/250.800/1`,
    `own/${ARTIST}/0250.800.0.x/1`,
    `own/${ARTIST}/250.800.x.y/1`,
    "own",
  ]) {
    assert.ok(!buy([{ key, newValue: ALICE }], { accountActions: pay(ALICE, ARTIST, 10n ** 9n) }), key);
  }
  // A name may contain dots.
  assert.ok(buy([{ key: own(0, "250.800.0.tour.2027"), newValue: ALICE }]));
});

test("tokens mix with owned records in one transaction", () => {
  assert.ok(
    buy([
      { key: own(4), newValue: ALICE },
      { key: `user/${ALICE}/question/${ARTIST}/${ITEM}/4`, newValue: "What inspired the record?" },
    ]),
  );
  assert.ok(
    !buy([
      { key: own(4), newValue: ALICE },
      { key: `user/${BOB}/question/${ARTIST}/${ITEM}/4`, newValue: "forged" },
    ]),
  );
});
