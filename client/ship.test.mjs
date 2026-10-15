import assert from "node:assert/strict";
import { test } from "node:test";
import * as read from "./read.mjs";
import * as ship from "./ship.mjs";
import { chain } from "./test-chain.mjs";
import * as write from "./write.mjs";

const sdk = await import(process.env.LATTICE_SDK);
const PATH = ["Nexus", "fanfare", "band"];

/** A stand-in for `window.lattice`: signs as the wallet does, with `who`'s key. */
function walletOf(who) {
  const pkcs8 = new Uint8Array([...sdk.hexToBytes("302e020100300506032b657004220420"), ...who.privateKey]);
  return {
    async signMessage({ text }) {
      const key = await crypto.subtle.importKey("pkcs8", pkcs8, "Ed25519", false, ["sign"]);
      const bytes = new TextEncoder().encode(`lattice-message:https://fanfare.example\n${text}`);
      return { publicKey: who.publicKey, signature: sdk.bytesToHex(new Uint8Array(await crypto.subtle.sign("Ed25519", key, bytes))) };
    },
  };
}
const account = () => sdk.accountFromPrivateKey(sdk.generatePrivateKey());

test("the artist's wallet gives the same key every time, and only it opens an address", async () => {
  const [artist, other] = [account(), account()];
  const key = await ship.artistKey(walletOf(artist));
  assert.equal((await ship.artistKey(walletOf(artist))).publicKey, key.publicKey);
  const address = { name: "Alice", line1: "1 Main St", city: "Berlin", country: "DE" };
  const sealed = await ship.seal(key.publicKey, address);
  assert.ok(!sealed.includes("Main"));
  assert.deepEqual(await ship.open(key.privateKey, sealed), address);
  assert.equal(await ship.open((await ship.artistKey(walletOf(other))).privateKey, sealed), undefined);
  assert.equal(await ship.open(key.privateKey, "not json"), undefined);
});

test("a fan who holds merch leaves a sealed address the artist finds", async () => {
  const [ARTIST, ALICE] = ["artist", "alice"];
  const c = chain(sdk, PATH, { [ARTIST]: 10, [ALICE]: 1000, bob: 10 });
  assert.ok(await c.write(ARTIST, [
    ...write.listing(ARTIST, "shirt", { kind: "merch", title: "Tour shirt" }),
    ...write.mint(ARTIST, "shirt/1", { price: 30n }),
    ...write.mint(ARTIST, "shirt/2", { price: 30n }),
  ]));
  const shirt = await read.ticket(c.state, ARTIST, "shirt/1");
  const key = await ship.artistKey(walletOf(account()));
  const sealed = await ship.seal(key.publicKey, { city: "Berlin" });
  // Buying and leaving the address is one write.
  const bought = write.buy(shirt, ALICE);
  assert.ok(c.submit(ALICE, [...bought.actions, ...(await write.changes(c.state, write.ship(ALICE, ARTIST, "shirt/1", sealed)))], bought.payments));
  const [found, ...rest] = await read.shipments(c.state, ARTIST, "shirt");
  assert.equal(rest.length, 0);
  assert.equal(found.ticket.holder, ALICE);
  assert.deepEqual(await ship.open(key.privateKey, found.sealed), { city: "Berlin" });
  // Someone else's record for an item they don't hold doesn't count.
  assert.ok(await c.write("bob", write.ship("bob", ARTIST, "shirt/2", sealed)));
  assert.equal((await read.shipments(c.state, ARTIST, "shirt")).length, 1);
});
