// Fanfare through the real Lattice Wallet: each person has a headless
// Chromium with the built extension installed and holding their key, and
// approves whatever the wallet asks in its own window, as a person would.
// The artist puts a show on sale, a fan buys a ticket and makes a door pass,
// and the artist checks the fan in at the door.
//
//   LATTICE=<lattice-node>/.build/debug/lattice \
//   LATTICE_SDK=<lattice-sdk>/packages/sdk/dist/index.js \
//   MONIKER=<moniker checkout> LATTICE_WALLET=<nexus-wallet>/dist npm run test:wallet
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { SECONDS, account, start } from "./stack.mjs";

const built = process.env.LATTICE_WALLET && fileURLToPath(new URL(process.env.LATTICE_WALLET, `file://${process.cwd()}/`));
if (!built) throw new Error("LATTICE_WALLET: the built Lattice Wallet extension (its dist/ directory)");
// The wallet as installed by someone whose node runs on this machine.
const installed = mkdtempSync(`${tmpdir()}/fanfare-ui-wallet-`);
cpSync(built, installed, { recursive: true });
const manifest = JSON.parse(readFileSync(`${installed}/manifest.json`, "utf8"));
manifest.host_permissions = [...manifest.host_permissions, "http://127.0.0.1/*"];
writeFileSync(`${installed}/manifest.json`, JSON.stringify(manifest));

let stack;
const browsers = [];
before(async () => {
  stack = await start({ listen: 25051, rpc: 29400, publicRead: 29401, app: 8772 }, process.env.MONIKER);
});
after(async () => {
  for (const context of browsers) await context.close().catch(() => {});
  stack?.stop();
});

/**
 * A browser whose wallet holds `who`'s key, with the stack's node as its
 * node. Every wallet window is approved once the wallet lets its button be
 * pressed, and recorded.
 */
async function walletOf(who) {
  const context = await chromium.launchPersistentContext(mkdtempSync(`${tmpdir()}/fanfare-ui-browser-`), {
    headless: false,
    viewport: { width: 1100, height: 900 },
    args: ["--headless=new", `--disable-extensions-except=${installed}`, `--load-extension=${installed}`],
  });
  browsers.push(context);
  const [worker] = context.serviceWorkers().length ? context.serviceWorkers() : [await context.waitForEvent("serviceworker")];
  const origin = worker.url().split("/").slice(0, 3).join("/");
  context.approved = [];
  context.notes = []; // what a wallet window said when its button never woke
  context.on("page", async (opened) => {
    await opened.waitForLoadState().catch(() => {});
    if (!opened.url().includes("/approve/index.html")) return;
    // The button wakes only in a focused window, once the whole request has been seen.
    await opened.bringToFront();
    const approve = opened.getByRole("button", { name: /^(Connect|Sign write|Sign message|Pay .+)$/ });
    const rest = opened.getByRole("button", { name: /^See the rest/ });
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline && !(await approve.isEnabled().catch(() => false))) {
      if (await rest.isVisible().catch(() => false)) await rest.click().catch(() => {});
      await opened.waitForTimeout(250);
    }
    if (!(await approve.isEnabled().catch(() => false))) {
      context.notes.push((await opened.locator("body").innerText().catch(() => "?")).replace(/\s+/g, " ").slice(0, 400));
      return;
    }
    const label = await approve.textContent();
    await approve.click();
    context.approved.push(label.trim());
  });
  const setup = await context.newPage();
  await setup.goto(`${origin}/popup/index.html`);
  const created = await setup.evaluate((privHex) => chrome.runtime.sendMessage({ type: "createWallet", password: "fanfare-test", privHex }), who.keyHex);
  if (!created?.ok) throw new Error(`wallet setup: ${created?.error}`);
  await setup.evaluate(async (url) => {
    const { settings } = await chrome.storage.local.get("settings");
    const endpoints = { ...(settings?.endpoints ?? {}), Nexus: { url, acceptsSubmit: true, source: "user" } };
    await chrome.storage.local.set({ settings: { ...settings, nodeMode: "custom", endpoints } });
  }, stack.node);
  await setup.close();
  const page = context.pages()[0] ?? (await context.newPage());
  page.on("pageerror", (error) => console.error("page error:", error.message));
  return { context, page };
}

/** Waits for a form's status line to say `text`; on failure, says what the page and the wallet said. */
async function status(person, scope, text) {
  const line = person.page.locator(`${scope} .status`).last();
  await line.filter({ hasText: text }).waitFor({ timeout: SECONDS * 1000 }).catch(async (error) => {
    const said = await line.textContent().catch(() => "?");
    throw new Error(`status said "${said}", not "${text}"; wallet approved [${person.context.approved}], said: ${person.context.notes.join(" || ") || "nothing"}`, { cause: error });
  });
}

const visit = (person, hash = "") => person.page.goto(`${stack.app}${hash}`);

let artist;
let alice;
let code;

test("the artist connects the real wallet and puts a show on sale", async () => {
  artist = await walletOf(stack.artist);
  await visit(artist, "#/sell");
  await artist.page.getByRole("button", { name: "Connect wallet" }).first().click();
  await artist.page.locator("#who .chip").waitFor({ timeout: 60_000 });
  await artist.page.locator("h1", { hasText: "Sell on Fanfare" }).waitFor({ timeout: 60_000 });
  await artist.page.locator("#nl-title").waitFor();
  await artist.page.fill("#nl-title", "Berlin");
  await artist.page.fill("#nl-date", "2030-11-14");
  await artist.page.fill("#nl-count", "2");
  await artist.page.fill("#nl-price", "250");
  await artist.page.click('form[data-act="create-listing"] button[type=submit]');
  await status(artist, 'form[data-act="create-listing"]', "Done.");
  assert.deepEqual(artist.context.approved, ["Connect", "Sign write"]);
});

test("a fan buys a ticket: the wallet asks to pay the price", async () => {
  alice = await walletOf(stack.alice);
  await visit(alice, `#/a/${encodeURIComponent(`@${stack.artist.address}`)}`);
  await alice.page.getByRole("button", { name: "Connect wallet" }).click();
  // Connecting redraws the page; buy from the page as it is once connected.
  await alice.page.locator("#who .chip").waitFor({ timeout: 60_000 });
  await alice.page.locator('#l-berlin [data-act="buy"]', { hasText: "Buy ticket" }).waitFor();
  await alice.page.locator('#l-berlin [data-act="buy"]').click();
  await alice.page.click('form[data-act="confirm-buy"] button[type=submit]');
  await status(alice, 'form[data-act="confirm-buy"]', "Done.");
  // The wallet asks for the same total the page showed; this node takes any fee.
  assert.equal(alice.context.approved.at(-1), "Pay 250");
  assert.equal(await stack.balance(stack.alice), 2000n - 250n);
});

test("the fan's wallet signs a door pass, and the artist checks them in", async () => {
  await visit(alice, "#/me");
  const row = alice.page.locator('li[data-ticket="berlin/1"]');
  await row.locator('[data-act="pass"]').click();
  await row.locator(".pass > svg").waitFor({ timeout: 60_000 });
  assert.equal(alice.context.approved.at(-1), "Sign message");
  // What the QR code holds: the pass, kept in the fan's browser.
  code = await alice.page.evaluate(() => {
    const key = Object.keys(localStorage).find((k) => k.startsWith("fanfare.pass|"));
    return JSON.parse(localStorage.getItem(key));
  });

  await visit(artist, `#/door/${encodeURIComponent(`@${stack.artist.address}`)}/berlin`);
  await artist.page.locator("h1", { hasText: "Door · Berlin" }).waitFor();
  await artist.page.fill("#code", code);
  await artist.page.click('form[data-act="check-pass"] button[type=submit]');
  await artist.page.locator(".verdict.good", { hasText: "Let them in" }).waitFor({ timeout: SECONDS * 1000 }).catch((error) => {
    throw new Error(`no "Let them in"; wallet approved [${artist.context.approved}], said: ${artist.context.notes.join(" || ") || "nothing"}`, { cause: error });
  });
  assert.equal(artist.context.approved.at(-1), "Sign write");
});

test("a new artist with no FAN at all puts a show on sale: the fee is 0", async () => {
  const newcomer = account();
  assert.equal(await stack.balance(newcomer), 0n);
  const person = await walletOf(newcomer);
  await visit(person, "#/sell");
  await person.page.getByRole("button", { name: "Connect wallet" }).first().click();
  await person.page.locator("#who .chip").waitFor({ timeout: 60_000 });
  await person.page.locator("#nl-title").waitFor();
  assert.equal(await person.page.locator(".note", { hasText: "network fee" }).count(), 0, "no fee to warn about");
  await person.page.fill("#nl-title", "First gig");
  await person.page.fill("#nl-date", "2030-12-01");
  await person.page.fill("#nl-count", "10");
  await person.page.fill("#nl-price", "20");
  await person.page.click('form[data-act="create-listing"] button[type=submit]');
  await status(person, 'form[data-act="create-listing"]', "Done.");
  assert.deepEqual(person.context.approved, ["Connect", "Sign write"]);
});
