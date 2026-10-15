// The page (`app/`) in headless Chromium against a private Lattice stack: one
// node mines Nexus, the shared profile chain, the Fanfare home chain and one
// artist chain, each launched with its premine to the artist. Each person
// has their own browser context with a stand-in for the Lattice wallet's
// `window.lattice` that signs with their key the way the wallet does (the
// transaction body write.mjs builds, checked against the wallet's own code,
// and "lattice-message:" + origin for messages) and sends through the node.
//
//   cd e2e/ui && npm ci && npx playwright install chromium
//   LATTICE=<lattice-node>/.build/debug/lattice \
//   LATTICE_SDK=<lattice-sdk>/packages/sdk/dist/index.js \
//   MONIKER=<moniker checkout> npm test
//
// Screenshots go to $SHOTS when it is set.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import * as door from "../../client/door.mjs";
import * as launch from "../../client/launch.mjs";
import * as wallet from "../../client/wallet.mjs";
import * as write from "../../client/write.mjs";

const sdk = await import(process.env.LATTICE_SDK);
const here = (path) => fileURLToPath(new URL(path, import.meta.url));
const PROFILE_DIR = process.env.MONIKER;
const CHAIN = launch.chainPath("band");
const PROFILE = ["Nexus", "moniker"];
const [listen, rpc, publicRead, appPort] = [25041, 29390, 29391, 8771];
const node = `http://127.0.0.1:${publicRead}`;
const APP = `http://127.0.0.1:${appPort}/app/?node=${encodeURIComponent(node)}`;
const SECONDS = Number(process.env.E2E_SECONDS ?? 300);

const root = mkdtempSync(`${tmpdir()}/fanfare-ui-`);
const lattice = (...args) => execFileSync(process.env.LATTICE, [...args, "--root", root], { encoding: "utf8" });
const configure = (change) => {
  const file = `${root}/lattice.json`;
  const topology = JSON.parse(readFileSync(file, "utf8"));
  change(topology);
  writeFileSync(file, JSON.stringify(topology, null, 2));
};
const account = () => sdk.accountFromPrivateKey(sdk.generatePrivateKey());
const [miner, artist, alice, bob] = [account(), account(), account(), account()];

async function until(label, condition, seconds = SECONDS) {
  const deadline = Date.now() + seconds * 1000;
  let failure;
  for (;;) {
    const value = await condition().catch((error) => void (failure = error));
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`, { cause: failure });
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}
async function api(path, chain) {
  const url = new URL(path, node);
  url.searchParams.set("chainPath", chain.join("/"));
  const response = await fetch(url, { cache: "no-store" });
  return response.ok ? response.json() : undefined;
}
const balance = async (who, chain = CHAIN) => BigInt((await api(`/api/state/account/${who.address}`, chain))?.balance ?? 0);

/** What the wallet does with a writeRecords request: nonce from its node, the body, the signature, the send. */
async function send(who, request) {
  const body = write.transaction({
    owner: who.address,
    actions: request.actions,
    payments: (request.payments ?? []).map(({ to, amount }) => ({ to, amount: BigInt(amount) })),
    fee: BigInt(request.fee),
    nonce: BigInt((await api(`/api/state/account/${who.address}`, request.chainPath))?.nonce ?? 0),
    chainPath: request.chainPath,
  });
  const { publicKey, signature } = sdk.signTransactionBody(body, who.privateKey);
  const response = await fetch(new URL("/transactions", node), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(sdk.transactionPayload({ [publicKey]: signature }, body)),
  });
  const text = await response.text();
  return response.ok ? { ok: true, transactionCID: JSON.parse(text).transactionCID ?? "" } : { ok: false, error: `The node refused it: ${text}` };
}

/** Ed25519 over "lattice-message:" + origin + "\n" + text, as the wallet signs. */
async function signMessage(who, origin, text) {
  const pkcs8 = new Uint8Array([...sdk.hexToBytes("302e020100300506032b657004220420"), ...who.privateKey]);
  const key = await crypto.subtle.importKey("pkcs8", pkcs8, "Ed25519", false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", key, door.signedBytes(origin, text)));
  return { publicKey: who.publicKey, signature: sdk.bytesToHex(signature) };
}

let browser;
let server;
const asked = [];

/** A browser context for `who`, with the stand-in wallet. */
async function person(who) {
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  await context.exposeFunction("__wallet", async (method, params, origin) => {
    asked.push(method);
    if (method === "connect" || method === "address") return { ok: true, address: who.address };
    if (method === "signMessage") return { ok: true, ...(await signMessage(who, origin, params.text)) };
    if (method === "writeRecords") return send(who, params);
    return { ok: false, error: "Unknown request" };
  });
  await context.addInitScript(() => {
    const call = async (method, params) => {
      const response = await window.__wallet(method, params, location.origin);
      if (!response.ok) throw new Error(response.error);
      return response;
    };
    Object.defineProperty(window, "lattice", {
      value: Object.freeze({
        isLatticeWallet: true,
        connect: async () => (await call("connect")).address,
        address: async () => (await call("address")).address,
        writeRecords: async (params) => ({ transactionCID: (await call("writeRecords", params)).transactionCID }),
        signMessage: async (params) => {
          const { publicKey, signature } = await call("signMessage", params);
          return { publicKey, signature };
        },
      }),
    });
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => console.error(`page error (${who === artist ? "artist" : "fan"}):`, error.message));
  return page;
}

/** Opens the page at `hash`, fresh, even when it is there already. */
async function visit(page, hash = "") {
  await page.goto("about:blank");
  await page.goto(`${APP}${hash}`);
}

async function shot(page, name) {
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/${name}.png`, fullPage: true });
}
/** Waits for a form's status line to say `text`, failing early on a bad one. */
async function status(page, scope, text) {
  const line = page.locator(`${scope} .status`).last();
  await line.filter({ hasText: text }).waitFor({ timeout: SECONDS * 1000 }).catch(async (error) => {
    throw new Error(`status said "${await line.textContent().catch(() => "?")}", not "${text}"`, { cause: error });
  });
}

before(async () => {
  assert.ok(PROFILE_DIR, "MONIKER names the moniker checkout");
  lattice("init");
  configure((topology) => {
    Object.assign(topology, { listen, rpc, publicRead, webSocket: 0, publicSubmit: true });
    topology.publicReadExpensiveRate = 1000;
    topology.publicReadRate = 1000;
    topology.peers = [];
    topology.mine = { worker: "cpu", workers: 1, batchSize: 100000 };
  });
  lattice("child", "create", PROFILE.join("/"), "--spec", `${PROFILE_DIR}/chain/spec.json`,
    "--policy-module", `${PROFILE_DIR}/chain/moniker_policy.wasm`, "--premine-to", artist.address);
  lattice("child", "create", launch.HOME.join("/"));
  const specFile = `${root}/band.json`;
  writeFileSync(specFile, JSON.stringify(launch.spec()));
  lattice(...launch.createArguments({ name: "band", specFile, moduleFile: here("../../app/fanfare_policy.wasm"), artist: artist.address }));
  configure((topology) => {
    topology.mine.recipients = Object.fromEntries([launch.HOME, CHAIN, PROFILE].map((c) => [c.join("/"), miner.address]));
  });
  lattice("up");
  lattice("mine", "start");
  await until("both premines", async () => (await balance(artist)) > 0n && (await balance(artist, PROFILE)) > 0n);
  // Fans get coin from the artist; the market's legs are the wallet's.
  assert.ok((await send(artist, wallet.writeRequest(CHAIN, { actions: [{ key: `user/${artist.address}/hello`, newValue: "1" }], payments: [{ to: alice.address, amount: 2000n }, { to: bob.address, amount: 2000n }] }))).ok);
  await until("fans funded", async () => (await balance(bob)) === 2000n);
  // The artist's card on Moniker: a name, a site that doesn't list them back, a link.
  const card = { name: "The Band", url: "https://band.invalid", links: [{ label: "Bandcamp", url: "https://band.invalid/music" }] };
  assert.ok((await send(artist, wallet.writeRequest(PROFILE, { actions: [{ key: `user/${artist.address}/profile`, newValue: JSON.stringify(card) }] }))).ok);
  await until("the card", async () => (await balance(artist, PROFILE)) < launch.premineAmount(launch.spec()));

  server = spawn("python3", ["-m", "http.server", String(appPort), "--bind", "127.0.0.1"], { cwd: here("../.."), stdio: "ignore" });
  await until("the page server", () => fetch(`http://127.0.0.1:${appPort}/app/`).then((r) => r.ok), 20);
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  server?.kill();
  try { lattice("mine", "stop"); } catch {}
  try { lattice("down"); } catch {}
});

let artistPage;
let alicePage;

test("the home page lists the artist by their Moniker name, their site not confirmed", async () => {
  artistPage = await person(artist);
  await visit(artistPage);
  await artistPage.locator('[data-artist="band"]').filter({ hasText: "The Band" }).filter({ hasText: "band.invalid · not confirmed" }).waitFor();
  await shot(artistPage, "1-home");
  await artistPage.click('[data-artist="band"]');
  await artistPage.locator("h1", { hasText: "The Band" }).waitFor();
  await artistPage.locator(".links a", { hasText: "Bandcamp" }).waitFor();
  assert.match(await artistPage.locator(".coin .big").textContent(), /^\d{2},\d{3},\d{3}$/);
  assert.equal(await artistPage.locator(".note.warn").count(), 0, "the default spec runs the Fanfare policy");
});

test("the artist puts a show on sale from the page", async () => {
  await artistPage.click('[data-act="new-listing"]');
  await artistPage.fill("#nl-title", "Berlin");
  await artistPage.fill("#nl-venue", "Tresor");
  await artistPage.fill("#nl-count", "3");
  await artistPage.fill("#nl-price", "250");
  await shot(artistPage, "2-new-listing");
  await artistPage.click('form[data-act="create-listing"] button[type=submit]');
  await status(artistPage, 'form[data-act="create-listing"]', "Done.");
  await artistPage.locator("#l-berlin").filter({ hasText: "3 tickets" }).waitFor();
  // The artist holds every new ticket: the page shows it on sale rather than offering to buy.
  assert.equal(await artistPage.locator("#l-berlin .seats li", { hasText: "on sale" }).count(), 3);
  await shot(artistPage, "3-on-sale");
});

test("a fan buys a ticket; a fan who saw it earlier is told it sold", async () => {
  alicePage = await person(alice);
  const bobPage = await person(bob);
  await Promise.all([visit(alicePage, "#/a/band"), visit(bobPage, "#/a/band")]);
  await Promise.all([alicePage, bobPage].map((p) => p.locator('#l-berlin [data-ticket="berlin/1"]').waitFor()));

  await alicePage.click('#l-berlin [data-ticket="berlin/1"]');
  await alicePage.click('form[data-act="confirm-buy"] button[type=submit]');
  await status(alicePage, 'form[data-act="confirm-buy"]', "Done.");

  await bobPage.click('#l-berlin [data-ticket="berlin/1"]');
  await bobPage.click('form[data-act="confirm-buy"] button[type=submit]');
  await status(bobPage, 'form[data-act="confirm-buy"]', "Someone else got this ticket first.");
  await shot(bobPage, "4-sold-to-someone-else");
  await bobPage.context().close();
});

let code;
test("the fan's tickets: a pass for the door, and a resale price", async () => {
  await visit(alicePage, "#/me");
  const row = alicePage.locator('li[data-ticket="berlin/1"]');
  await row.waitFor();
  await row.locator('[data-act="pass"]').click();
  await row.locator(".pass svg").waitFor();
  await shot(alicePage, "5-pass");
  // The QR code holds what the wallet signed; the scanner gets the same text.
  const origin = `http://127.0.0.1:${appPort}`;
  code = await door.pass({ signMessage: ({ text }) => signMessage(alice, origin, text) }, origin, artist.address, "berlin/1");

  await row.locator('[data-act="resell"]').click();
  await row.locator("#rp").fill("400");
  await row.locator("button[type=submit]").click();
  await status(alicePage, 'form[data-act="resell-confirm"]', "Done.");
  await alicePage.locator('li[data-ticket="berlin/1"] .tag', { hasText: "for sale at 400" }).waitFor({ timeout: 10_000 });
});

test("the door: pick the show, a good pass is checked in, and it works once", async () => {
  await visit(artistPage, "#/door/band");
  await artistPage.click("a.card", { hasText: "Berlin" });
  await artistPage.locator("h1", { hasText: "Door · Berlin" }).waitFor();
  await artistPage.fill("#code", code);
  await artistPage.click('form[data-act="check-pass"] button[type=submit]');
  await artistPage.locator(".verdict.good", { hasText: "Let them in" }).waitFor({ timeout: SECONDS * 1000 });
  await shot(artistPage, "6-door-ok");
  // The same pass again at this door, then at a door that didn't see it.
  await artistPage.click('form[data-act="check-pass"] button[type=submit]');
  await artistPage.locator(".verdict.bad", { hasText: "already let in at this door" }).waitFor();
  await visit(artistPage, "#/door/band/berlin");
  await artistPage.fill("#code", code);
  await artistPage.click('form[data-act="check-pass"] button[type=submit]');
  await artistPage.locator(".verdict.bad", { hasText: "already checked in" }).waitFor();
  await shot(artistPage, "7-door-used");
});

test("a checked-in ticket Alice still sells is marked used, and a buyer is warned", async () => {
  const bobPage = await person(bob);
  await visit(bobPage, "#/a/band");
  const seat = bobPage.locator("#l-berlin .seats li", { hasText: "resale" });
  await seat.locator(".tag.used").waitFor();
  await seat.locator('[data-act="buy"]').click();
  await bobPage.locator('form[data-act="confirm-buy"] .warn-text', { hasText: "already checked in" }).waitFor();
  await shot(bobPage, "7b-used-warning");
  await bobPage.context().close();
});

test("Q&A: a fan buys a slot and asks; the artist answers", async () => {
  await visit(artistPage, "#/a/band");
  await artistPage.click('[data-act="new-listing"]');
  await artistPage.check('input[name=kind][value=qa]');
  await artistPage.fill("#nl-title", "Ask me anything");
  await artistPage.fill("#nl-count", "2");
  await artistPage.fill("#nl-price", "50");
  await artistPage.click('form[data-act="create-listing"] button[type=submit]');
  await status(artistPage, 'form[data-act="create-listing"]', "Done.");

  await visit(alicePage, "#/a/band");
  await alicePage.click('#l-ask-me-anything [data-ticket="ask-me-anything/1"]');
  await alicePage.fill("#ask", "What's the next album called?");
  await alicePage.click('form[data-act="confirm-buy"] button[type=submit]');
  await status(alicePage, 'form[data-act="confirm-buy"]', "Done.");

  await visit(artistPage, "#/a/band");
  const form = artistPage.locator('form[data-act="answer"]');
  await form.waitFor({ timeout: 30_000 });
  await form.locator("textarea").fill("Fanfare.");
  await form.locator("button[type=submit]").click();
  await status(artistPage, 'form[data-act="answer"]', "Done.");
  await artistPage.waitForTimeout(1500);
  await artistPage.locator(".qa .answer", { hasText: "Fanfare." }).waitFor({ timeout: 30_000 });
  await shot(artistPage, "8-qa");
});

test("merch: the artist's key goes on their profile; a fan's address opens only for the artist", async () => {
  await artistPage.click('[data-act="new-listing"]');
  await artistPage.check('input[name=kind][value=merch]');
  await artistPage.fill("#nl-title", "Tour shirt");
  await artistPage.fill("#nl-count", "1");
  await artistPage.fill("#nl-price", "30");
  await artistPage.click('form[data-act="create-listing"] button[type=submit]');
  await status(artistPage, 'form[data-act="create-listing"]', "Done.");
  await artistPage.waitForTimeout(1500);
  await artistPage.click('[data-act="shipping"]');
  await artistPage.click('[data-act="publish-key"]');
  await status(artistPage, "#shipping", "Done.");

  await visit(alicePage, "#/a/band");
  await alicePage.click('#l-tour-shirt [data-ticket="tour-shirt/1"]');
  const form = alicePage.locator('form[data-act="confirm-buy"]');
  await form.locator("[name=name]").fill("Alice");
  await form.locator("[name=line1]").fill("1 Main St");
  await form.locator("[name=city]").fill("Berlin");
  await form.locator("[name=country]").fill("Germany");
  await shot(alicePage, "9-merch");
  await form.locator("button[type=submit]").click();
  await status(alicePage, 'form[data-act="confirm-buy"]', "Done.");

  await visit(artistPage, "#/a/band");
  await artistPage.click('[data-act="shipping"]');
  await artistPage.locator(".addresses li", { hasText: "1 Main St" }).waitFor();
  await shot(artistPage, "10-addresses");

  // At phone width nothing scrolls sideways.
  await artistPage.setViewportSize({ width: 390, height: 844 });
  await shot(artistPage, "12-phone");
  const wide = await artistPage.evaluate(() =>
    [...document.querySelectorAll("body *")].filter((el) => el.getBoundingClientRect().right > 391).map((el) => `${el.tagName}.${el.className}`).slice(0, 5));
  assert.deepEqual(wide, [], "nothing runs past the right edge");
  await artistPage.setViewportSize({ width: 1100, height: 900 });
});

test("launch: the page names the chain, checks the name, and gives the command", async () => {
  await visit(artistPage, "#/launch");
  await artistPage.fill("#ln", "band");
  await artistPage.click('form[data-act="launch-command"] button[type=submit]');
  await artistPage.locator(".status.bad", { hasText: "band is taken" }).waitFor();
  await artistPage.fill("#ln", "choir");
  await artistPage.click('form[data-act="launch-command"] button[type=submit]');
  const command = await artistPage.locator("#ln-steps pre").textContent();
  assert.match(command, new RegExp(`child create Nexus/fanfare/choir --spec choir.json --policy-module fanfare_policy.wasm --premine-to ${artist.address}`));
  await shot(artistPage, "11-launch");
});

test("the shipped policy module is the one built from policy/", () => {
  assert.deepEqual(
    readFileSync(here("../../app/fanfare_policy.wasm")),
    readFileSync(here("../../policy/target/wasm32-unknown-unknown/release/fanfare_policy.wasm")),
  );
});
