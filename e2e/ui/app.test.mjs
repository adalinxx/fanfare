// The page (`app/`) in headless Chromium against a private Lattice stack: one
// node mines Nexus, the shared profile chain, the Fanfare chain (where the
// artist sells from their wallet) and one artist's own coin chain, each
// launched with its premine to the artist. Each person
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
const HOME = launch.HOME;
const CHAIN = launch.chainPath("band");
const PROFILE = ["Nexus", "moniker"];
const [listen, rpc, publicRead, appPort] = [25041, 29390, 29391, 8771];
const node = `http://127.0.0.1:${publicRead}`;
const APP = `http://127.0.0.1:${appPort}/app/?${new URLSearchParams({ node, home: "Nexus/fanfare", profile: "Nexus/moniker" })}`;
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
const balance = async (who, chain = HOME) => BigInt((await api(`/api/state/account/${who.address}`, chain))?.balance ?? 0);

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
  // The Fanfare chain runs the Fanfare policy, as the trial does.
  const specFile = `${root}/spec.json`;
  writeFileSync(specFile, JSON.stringify(launch.spec()));
  const policy = here("../../app/fanfare_policy.wasm");
  lattice("child", "create", HOME.join("/"), "--spec", specFile, "--policy-module", policy, "--premine-to", artist.address);
  lattice(...launch.createArguments({ name: "band", specFile, moduleFile: policy, artist: artist.address }));
  configure((topology) => {
    topology.mine.recipients = Object.fromEntries([HOME, CHAIN, PROFILE].map((c) => [c.join("/"), miner.address]));
  });
  lattice("up");
  lattice("mine", "start");
  await until("the premines", async () => (await balance(artist)) > 0n && (await balance(artist, CHAIN)) > 0n && (await balance(artist, PROFILE)) > 0n);
  // Fans get FAN from the artist; the market's legs are the wallet's.
  const fund = (chain) => send(artist, wallet.writeRequest(chain, { actions: [{ key: `user/${artist.address}/hello`, newValue: chain.join("/") }], payments: [{ to: alice.address, amount: 2000n }, { to: bob.address, amount: 2000n }] }));
  assert.ok((await fund(HOME)).ok);
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
const ME = () => `#/a/${encodeURIComponent(`@${artist.address}`)}`;
const SHOW_DATE = "2030-11-14";

test("an artist sells from their wallet: a show on sale in five fields", async () => {
  artistPage = await person(artist);
  await visit(artistPage, "#/sell");
  await artistPage.locator("h1", { hasText: "Sell on Fanfare" }).waitFor();
  await artistPage.fill("#nl-title", "Berlin");
  await artistPage.fill("#nl-date", SHOW_DATE);
  await artistPage.fill("#nl-venue", "Tresor");
  await artistPage.fill("#nl-count", "3");
  await artistPage.fill("#nl-price", "250");
  await shot(artistPage, "2-sell");
  await artistPage.click('form[data-act="create-listing"] button[type=submit]');
  await status(artistPage, 'form[data-act="create-listing"]', "Done.");
  await artistPage.locator('form[data-act="create-listing"] .after', { hasText: "On sale" }).waitFor();
  await visit(artistPage, ME());
  await artistPage.locator("#l-berlin", { hasText: "Sold 0 of 3 tickets" }).waitFor();
  assert.equal(await artistPage.locator('#l-berlin [data-act="buy"]').count(), 0, "the artist isn't offered their own tickets");
  await artistPage.locator(".tools", { hasText: "Show fans this is really you" }).waitFor();
  await shot(artistPage, "3-artist-view");
});

test("the home page: what's coming up, and who sells, by their Moniker name", async () => {
  alicePage = await person(alice);
  await visit(alicePage);
  await alicePage.locator(".coming li", { hasText: "The Band" }).filter({ hasText: "14 Nov" }).waitFor();
  const card = alicePage.locator(`[data-artist="@${artist.address}"]`);
  await card.filter({ hasText: "The Band" }).waitFor();
  await card.locator(".badge-slot").waitFor({ state: "attached" });
  assert.equal(await card.locator(".verified").count(), 0, "a site that doesn't list the artist earns no check mark");
  assert.equal(await alicePage.locator("text=not confirmed").count(), 0, "and no warning either");
  await shot(alicePage, "1-home");
  await alicePage.locator(".coming a").first().click();
  await alicePage.locator("h1", { hasText: "The Band" }).waitFor();
  await alicePage.locator(".links a", { hasText: "Bandcamp" }).waitFor();
  assert.equal(await alicePage.locator(".coin").count(), 0, "no coin block for an artist selling in FAN");
});

test("one button buys a ticket, with the total shown first; a fan who saw it earlier is offered the next", async () => {
  const bobPage = await person(bob);
  await Promise.all([visit(alicePage, ME()), visit(bobPage, ME())]);
  await Promise.all([alicePage, bobPage].map((p) => p.locator('#l-berlin [data-act="buy"]', { hasText: "Buy ticket · 250 FAN" }).waitFor()));
  await alicePage.locator("#l-berlin", { hasText: "3 left" }).waitFor();

  await alicePage.click('#l-berlin [data-act="buy"]');
  const sheet = alicePage.locator('form[data-act="confirm-buy"]');
  await sheet.locator(".total", { hasText: "251 FAN" }).waitFor();
  await shot(alicePage, "4-buy");
  await sheet.locator("button[type=submit]", { hasText: "Pay 251 FAN in wallet" }).click();
  await status(alicePage, 'form[data-act="confirm-buy"]', "Done.");
  await sheet.locator(".after", { hasText: "It's yours" }).waitFor();

  await bobPage.click('#l-berlin [data-act="buy"]');
  await bobPage.click('form[data-act="confirm-buy"] button[type=submit]');
  await status(bobPage, 'form[data-act="confirm-buy"]', "Someone else got this ticket first.");
  await bobPage.locator('form[data-act="confirm-buy"] .status', { hasText: "Nothing was taken from you" }).waitFor();
  await shot(bobPage, "5-sold-to-someone-else");
  await bobPage.click('[data-act="buy-next"]');
  await bobPage.locator('form[data-act="confirm-buy"][data-ticket="berlin/2"]').waitFor();
  await bobPage.context().close();
});

let code;
test("my tickets: by show date, a door pass to keep, and a resale that shows the original price", async () => {
  await visit(alicePage, "#/me");
  await alicePage.locator("h2", { hasText: "Upcoming shows" }).waitFor();
  const row = alicePage.locator('li[data-ticket="berlin/1"]');
  await row.filter({ hasText: "The Band" }).filter({ hasText: "14 Nov 2030" }).waitFor();
  await row.locator('[data-act="pass"]').click();
  await row.locator(".pass > svg").waitFor();
  await row.locator(".pass", { hasText: "until the ticket is checked in" }).waitFor();
  await shot(alicePage, "6-pass");
  // The QR code holds what the wallet signed; the scanner gets the same text.
  const origin = `http://127.0.0.1:${appPort}`;
  code = await door.pass({ signMessage: ({ text }) => signMessage(alice, origin, text) }, origin, HOME.join("/"), artist.address, "berlin/1");
  // Signed once: it opens again without asking the wallet.
  const signs = asked.filter((m) => m === "signMessage").length;
  await visit(alicePage, "#/me");
  await alicePage.locator('li[data-ticket="berlin/1"] [data-act="pass"]').click();
  await alicePage.locator('li[data-ticket="berlin/1"] .pass > svg').waitFor();
  assert.equal(asked.filter((m) => m === "signMessage").length, signs);
  // The pass on its own page, as a phone opens it: no header, no wallet.
  await visit(alicePage, `#/pass/${encodeURIComponent(code)}`);
  await alicePage.locator(".pass.full svg").waitFor();
  assert.ok(!(await alicePage.locator("header.top").isVisible()));

  await visit(alicePage, "#/me");
  const again = alicePage.locator('li[data-ticket="berlin/1"]');
  await again.locator('[data-act="resell"]').click();
  await again.locator(".form-slot", { hasText: "It cost 250 FAN new" }).waitFor();
  await again.locator("#rp").fill("400");
  await again.locator("button[type=submit]").click();
  await status(alicePage, 'form[data-act="resell-confirm"]', "Done.");
  await alicePage.locator('li[data-ticket="berlin/1"] .tag', { hasText: "On sale at 400 FAN" }).waitFor({ timeout: 10_000 });
});

test("the door: pick the show, a good pass is checked in, and it works once", async () => {
  await visit(artistPage, `#/door/${encodeURIComponent(`@${artist.address}`)}`);
  await artistPage.locator("a.card", { hasText: "Berlin" }).click();
  await artistPage.locator("h1", { hasText: "Door · Berlin" }).waitFor();
  await artistPage.fill("#code", code);
  await artistPage.click('form[data-act="check-pass"] button[type=submit]');
  await artistPage.locator(".verdict.good", { hasText: "Let them in" }).waitFor({ timeout: SECONDS * 1000 });
  await shot(artistPage, "7-door-ok");
  // The same pass again at this door, then at a door that didn't see it.
  await artistPage.click('form[data-act="check-pass"] button[type=submit]');
  await artistPage.locator(".verdict.bad", { hasText: "already let in at this door" }).waitFor();
  await visit(artistPage, `#/door/${encodeURIComponent(`@${artist.address}`)}/berlin`);
  // A pass link, as a phone shows it, scans the same.
  await artistPage.fill("#code", `http://127.0.0.1:${appPort}/app/#/pass/${encodeURIComponent(code)}`);
  await artistPage.click('form[data-act="check-pass"] button[type=submit]');
  await artistPage.locator(".verdict.bad", { hasText: "already checked in" }).waitFor();
});

test("a used ticket still on resale is marked, and a buyer is warned", async () => {
  const bobPage = await person(bob);
  await visit(bobPage, ME());
  const resales = bobPage.locator("#l-berlin details.resales");
  await resales.locator("summary").click();
  const seat = resales.locator(".seats li", { hasText: "400 FAN" });
  await seat.filter({ hasText: "+60% on 250" }).locator(".tag.used").waitFor();
  await seat.locator('[data-act="buy"]').click();
  await bobPage.locator('form[data-act="confirm-buy"] .warn-text', { hasText: "already checked in" }).waitFor();
  await bobPage.locator('form[data-act="confirm-buy"]', { hasText: "originally 250 FAN" }).waitFor();
  await shot(bobPage, "8-used-warning");
  await bobPage.context().close();
});

test("a gift is confirmed by name before the wallet asks", async () => {
  await visit(alicePage, "#/me");
  const row = alicePage.locator('li[data-ticket="berlin/1"]');
  await row.locator('[data-act="give"]').click();
  await row.locator("#to").fill(bob.address);
  await row.locator("button[type=submit]").click();
  await row.locator(".status", { hasText: "you can't take it back" }).waitFor();
  await shot(alicePage, "9-give");
  await row.locator("button[type=submit]", { hasText: "Give to" }).click();
  await status(alicePage, 'form[data-act="give-confirm"]', "Done.");

  // At phone width nothing scrolls sideways.
  await artistPage.setViewportSize({ width: 390, height: 844 });
  await visit(artistPage, ME());
  await artistPage.locator("#l-berlin").waitFor();
  await shot(artistPage, "10-phone");
  const wide = await artistPage.evaluate(() =>
    [...document.querySelectorAll("body *")].filter((el) => el.getBoundingClientRect().right > 391).map((el) => `${el.tagName}.${el.className}`).slice(0, 5));
  assert.deepEqual(wide, [], "nothing runs past the right edge");
  await artistPage.setViewportSize({ width: 1100, height: 900 });
});

test("an artist's own coin: prices in it, its risk said plainly; launch names the chain and gives the command", async () => {
  await visit(alicePage, "#/a/band");
  await alicePage.locator(".coin", { hasText: "its price can fall to nothing" }).waitFor();
  await alicePage.locator(".artist-head", { hasText: "Prices in their own coin, band" }).waitFor();

  await visit(artistPage, "#/launch");
  await artistPage.locator(".consider", { hasText: "Most artists don't need this" }).waitFor();
  await artistPage.fill("#ln", "band");
  await artistPage.click('form[data-act="launch-command"] button[type=submit]');
  await artistPage.locator(".status.bad", { hasText: "band is taken" }).waitFor();
  await artistPage.fill("#ln", "choir");
  await artistPage.click('form[data-act="launch-command"] button[type=submit]');
  const command = await artistPage.locator("#ln-steps pre").textContent();
  assert.match(command, new RegExp(`child create Nexus/fanfare/choir --spec choir.json --policy-module fanfare_policy.wasm --premine-to ${artist.address}`));
  await shot(artistPage, "13-own-coin");
});

test("the shipped policy module is the one built from policy/", () => {
  assert.deepEqual(
    readFileSync(here("../../app/fanfare_policy.wasm")),
    readFileSync(here("../../policy/target/wasm32-unknown-unknown/release/fanfare_policy.wasm")),
  );
});
