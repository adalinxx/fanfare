import assert from "node:assert/strict";
import { test } from "node:test";
import {
  amountIn, byDate, coins, dateText, isArtistName, isItemName, newIds, parseRoute, seatOf, sellerAddress, slug, summary, today, walletMessage,
} from "./lib.mjs";

test("routes", () => {
  assert.deepEqual(parseRoute(""), { view: "home" });
  assert.deepEqual(parseRoute("#/a/band"), { view: "artist", key: "band" });
  assert.deepEqual(parseRoute("#/a/band/berlin/A1"), { view: "artist", key: "band", listing: "berlin/A1" });
  assert.deepEqual(parseRoute("#/a/%40bafyx"), { view: "artist", key: "@bafyx" });
  assert.deepEqual(parseRoute("#/door/@bafyx/berlin"), { view: "door", key: "@bafyx", listing: "berlin" });
  assert.deepEqual(parseRoute("#/me"), { view: "me" });
  assert.deepEqual(parseRoute("#/sell"), { view: "sell" });
  assert.deepEqual(parseRoute("#/pass/fanfare-pass%3A%7B%7D"), { view: "pass", code: "fanfare-pass:{}" });
  assert.deepEqual(parseRoute("#/a/%E0%A4%A"), { view: "artist", key: "%E0%A4%A" });
  assert.equal(sellerAddress("@bafyx"), "bafyx");
  assert.equal(sellerAddress("band"), undefined);
});

test("listings by date", () => {
  const l = (name, date) => ({ name, ...(date && { date }) });
  const split = byDate([l("a", "2026-12-01"), l("b", "2026-10-01"), l("c"), l("d", "2026-11-01"), l("e", "2026-09-01")], "2026-10-16");
  assert.deepEqual([split.upcoming, split.undated, split.past].map((x) => x.map((y) => y.name)), [["d", "a"], ["c"], ["b", "e"]]);
  assert.equal(today(new Date(2026, 0, 5)), "2026-01-05");
  assert.equal(dateText("2026-11-14"), "Sat 14 Nov 2026");
  assert.equal(dateText("soon"), "");
});

test("names, amounts and new ticket ids", () => {
  assert.ok(isArtistName("the-band_2") && !isArtistName("-x") && !isArtistName("a/b") && !isArtistName(""));
  assert.ok(isItemName("berlin/A1") && !isItemName("berlin/") && !isItemName("a b"));
  assert.equal(slug("Berlin · Tresor, Nov!"), "berlin-tresor-nov");
  assert.equal(slug("★★★"), "listing");
  assert.equal(amountIn(" 1,000 "), 1000n);
  assert.equal(amountIn("0"), undefined);
  assert.equal(amountIn("1.5"), undefined);
  assert.equal(amountIn(String(2n ** 64n)), undefined);
  assert.equal(coins(21000000n), "21,000,000");
  assert.deepEqual(newIds("show", ["show/1", "show/3"], 3), ["show/2", "show/4", "show/5"]);
  assert.equal(seatOf("berlin", "berlin/A1"), "A1");
  assert.equal(seatOf("berlin", "berlin"), "berlin");
});

test("a listing's summary: held by fans, for sale cheapest first", () => {
  const listing = { artist: "a" };
  const s = summary(listing, [
    { id: "x/1", holder: "a", price: 250n },
    { id: "x/2", holder: "fan", price: 200n },
    { id: "x/3", holder: "fan2" },
  ]);
  assert.deepEqual([s.total, s.held, s.cheapest, s.forSale.map((t) => t.id), s.next.id, s.left], [3, 2, 200n, ["x/2", "x/1"], "x/2", 1]);
  // A used ticket stays listed but isn't the cheapest.
  assert.equal(summary(listing, [{ id: "x/1", holder: "a", price: 250n }, { id: "x/2", holder: "fan", price: 200n }], new Set(["x/2"])).cheapest, 250n);
});

test("wallet errors said plainly", () => {
  assert.equal(walletMessage(new Error("The person declined")), "You declined in your wallet. Nothing was sent.");
  assert.equal(walletMessage(new Error("Not connected: call connect() first")), "Connect your wallet first.");
  assert.equal(walletMessage(undefined), "The wallet did not answer.");
});
