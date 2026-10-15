// node --test client/market.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import * as market from "./market.mjs";

const PATH = ["Nexus", "fanfare", "band"];
const row = (demander, amountDeposited, amountDemanded, nonce) => ({
  key: `${demander}/${amountDemanded}/${nonce}`,
  demander,
  amountDeposited,
  amountDemanded,
  nonce,
});
const intent = (request) => {
  const url = new URL(request);
  assert.equal(url.protocol, "lattice:");
  assert.equal(url.hostname, "order");
  assert.equal(url.searchParams.get("v"), "1");
  const encoded = url.searchParams.get("intent").replaceAll("-", "+").replaceAll("_", "/");
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0))));
};

test("a deposit row parses only when its key matches its fields", () => {
  assert.deepEqual(market.offer(row("alice", 100, 50, 3)), { seller: "alice", coin: 100n, price: 50n, depositNonce: 3n });
  assert.equal(market.offer({ ...row("alice", 100, 50, 3), key: "alice/49/3" }), undefined);
  assert.equal(market.offer(row("alice", 0, 50, 3)), undefined);
  assert.equal(market.offer(row("alice", 100, "05", 3)), undefined);
  assert.equal(market.offer(row("", 100, 50, 3)), undefined);
  assert.equal(market.offer(null), undefined);
});

test("offers reads every page, skips bad rows and sorts cheapest first", async () => {
  const pages = {
    "": { deposits: [row("alice", 100, 50, 0), { junk: true }], next: "c1" },
    c1: { deposits: [row("bob", 100, 20, 0), row("carol", 200, 40, 1)], next: null },
  };
  const asked = [];
  const fetchImpl = async (url) => {
    asked.push(url.searchParams.get("chainPath"));
    return { ok: true, json: async () => pages[url.searchParams.get("after") ?? ""] };
  };
  const found = await market.offers("http://node:8080", PATH, fetchImpl);
  assert.deepEqual(asked, ["Nexus/fanfare/band", "Nexus/fanfare/band"]);
  // bob and carol both ask 0.2 a coin; carol's larger offer comes first.
  assert.deepEqual(found.map((o) => o.seller), ["carol", "bob", "alice"]);
});

test("offers stops on a cursor that does not advance", async () => {
  let calls = 0;
  const fetchImpl = async () => (calls++, { ok: true, json: async () => ({ deposits: [], next: "same" }) });
  assert.deepEqual(await market.offers("http://node", PATH, fetchImpl), []);
  assert.equal(calls, 2);
});

test("pick takes whole offers until it has enough", () => {
  const sorted = [
    { seller: "a", coin: 100n, price: 10n, depositNonce: 0n },
    { seller: "b", coin: 100n, price: 20n, depositNonce: 0n },
  ];
  assert.deepEqual(market.pick(sorted, 150n), { offers: sorted, coin: 200n, price: 30n });
  assert.equal(market.pick(sorted, 100n).offers.length, 1);
  assert.equal(market.pick(sorted, 201n), undefined);
});

test("a sell request is what the wallet's order import expects", () => {
  const now = Date.parse("2026-10-15T12:00:00Z");
  assert.deepEqual(intent(market.sellRequest(PATH, 1000, 250, now)), {
    version: 1,
    parentChain: ["Nexus", "fanfare"],
    childChain: PATH,
    asset: "LAT",
    expiresAt: "2026-10-15T12:15:00.000Z",
    side: "sell_child",
    orderType: "limit",
    amountDeposited: "1000",
    amountDemanded: "250",
  });
  assert.throws(() => market.sellRequest(PATH, 0, 1));
  assert.throws(() => market.sellRequest(["Nexus"], 1, 1));
});

test("a buy request names each offer by the terms its deposit is keyed by", () => {
  const taken = [{ seller: "bafyalice", coin: 100n, price: 20n, depositNonce: 7n }];
  const value = intent(market.buyRequest(PATH, taken, 0));
  assert.equal(value.side, "buy_child");
  assert.equal(value.orderType, "take");
  assert.deepEqual(value.deposits, [{ demander: "bafyalice", amountDemanded: "20", amountDeposited: "100", depositNonce: "7" }]);
  assert.throws(() => market.buyRequest(PATH, []));
});
