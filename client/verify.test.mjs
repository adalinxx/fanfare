import assert from "node:assert/strict";
import { test } from "node:test";
import { linksBack, site, verify, WELL_KNOWN } from "./verify.mjs";

const ARTIST = "bafyreiartist";
/** A fetch that serves `files` by URL and nothing else. */
const serving = (files) => async (url, init) => {
  assert.equal(init.redirect, "error");
  const body = files[String(url)];
  return body === undefined ? { ok: false, status: 404 } : { ok: true, text: async () => body };
};

test("an artist is verified when the site on their card lists their address", async () => {
  const fetch = serving({ [`https://band.example${WELL_KNOWN}`]: `bafyreisomeoneelse\n${ARTIST}\r\n` });
  assert.deepEqual(await verify(ARTIST, { url: "https://band.example/tour" }, fetch), { verified: true, site: "band.example" });
  // Another artist naming the same site is not.
  assert.deepEqual(await verify("bafyreisquatter", { url: "https://band.example" }, fetch), { verified: false, site: "band.example" });
});

test("no site, a site that isn't https, or one that doesn't answer is unverified", async () => {
  const fetch = serving({ [`http://band.example${WELL_KNOWN}`]: ARTIST });
  assert.deepEqual(await verify(ARTIST, {}, fetch), { verified: false });
  assert.deepEqual(await verify(ARTIST, undefined, fetch), { verified: false });
  assert.deepEqual(await verify(ARTIST, { url: "http://band.example" }, fetch), { verified: false });
  assert.deepEqual(await verify(undefined, { url: "https://band.example" }, fetch), { verified: false });
  assert.equal(site("https://user:pw@band.example"), undefined);
  assert.equal(site("not a url"), undefined);
  assert.equal(await linksBack("https://band.example", ARTIST, async () => { throw new TypeError("CORS"); }), false);
  // A line only containing the address doesn't count.
  assert.equal(await linksBack("https://band.example", ARTIST, serving({ [`https://band.example${WELL_KNOWN}`]: `x${ARTIST}` })), false);
});
