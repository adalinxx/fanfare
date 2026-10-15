import assert from "node:assert/strict";
import { test } from "node:test";
import { amountIn, coins, isArtistName, isItemName, newIds, parseRoute, seatOf, slug, summary, walletMessage } from "./lib.mjs";

test("routes", () => {
  assert.deepEqual(parseRoute(""), { view: "home" });
  assert.deepEqual(parseRoute("#/a/band"), { view: "artist", name: "band" });
  assert.deepEqual(parseRoute("#/a/band/berlin/A1"), { view: "artist", name: "band", listing: "berlin/A1" });
  assert.deepEqual(parseRoute("#/door/band"), { view: "door", name: "band" });
  assert.deepEqual(parseRoute("#/me"), { view: "me" });
  assert.deepEqual(parseRoute("#/a/%E0%A4%A"), { view: "artist", name: "%E0%A4%A" });
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
  assert.deepEqual([s.total, s.held, s.cheapest, s.forSale.map((t) => t.id)], [3, 2, 200n, ["x/2", "x/1"]]);
  // A used ticket stays listed but isn't the cheapest.
  assert.equal(summary(listing, [{ id: "x/1", holder: "a", price: 250n }, { id: "x/2", holder: "fan", price: 200n }], new Set(["x/2"])).cheapest, 250n);
});

test("wallet errors said plainly", () => {
  assert.equal(walletMessage(new Error("The person declined")), "You declined in your wallet. Nothing was sent.");
  assert.equal(walletMessage(new Error("Not connected: call connect() first")), "Connect your wallet first.");
  assert.equal(walletMessage(undefined), "The wallet did not answer.");
});
