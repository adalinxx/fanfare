// Fanfare in the browser. Every record is read by CID from the node in
// Settings and checked here; every write and signature is the Lattice
// wallet's (`window.lattice`), approved by the person in the wallet's own
// window. The page keeps no key and no server.
import * as sdk from "./vendor/lattice-sdk.js";
import qrcode from "./vendor/qrcode.mjs";
import * as profiles from "./vendor/profile.mjs";
import * as door from "../client/door.mjs";
import * as launch from "../client/launch.mjs";
import * as market from "../client/market.mjs";
import * as read from "../client/read.mjs";
import { explain } from "../client/refusal.mjs";
import * as ship from "../client/ship.mjs";
import { chainSpec, premineRecipient, tip, view, volumeLoader } from "../client/state.mjs";
import { verify } from "../client/verify.mjs";
import * as wallet from "../client/wallet.mjs";
import * as write from "../client/write.mjs";
import {
  amountIn, artistHref, coins, esc, isArtistName, isItemName, newIds, parseRoute, plural, seatOf, short, slug, summary, unitOf, walletMessage,
} from "./lib.mjs";

// Settings, kept in this browser only.

const DEFAULTS = { node: "", home: "Nexus/fanfare", profile: "Nexus/moniker" };
const store = {
  get(key, fallback) {
    try {
      const value = localStorage.getItem(`fanfare.${key}`);
      return value === null ? fallback : JSON.parse(value);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`fanfare.${key}`, JSON.stringify(value));
    } catch {}
  },
};
const settings = { ...DEFAULTS, ...store.get("settings", {}) };
{
  const asked = new URLSearchParams(location.search).get("node");
  if (asked) settings.node = asked;
}
const nodeURL = () => settings.node.replace(/\/+$/, "");
const HOME = () => settings.home.split("/");
const PROFILE = () => settings.profile.split("/");
const chainOf = (name) => [...HOME(), name];
const ORIGIN = location.origin;

// Reading.

const volumesFor = (chain) => new sdk.VolumeClient(new sdk.HTTPVolumeTransport(`${nodeURL()}/volumes`, { chainPath: chain }));

async function api(path, chain) {
  const url = new URL(path, `${nodeURL()}/`);
  if (chain) url.searchParams.set("chainPath", chain.join("/"));
  const response = await fetch(url, { cache: "no-store" });
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`${url.host} answered ${response.status}`);
  return response.json();
}

/** The chain's state at the node's tip, as `{ get, list }`. */
async function stateOf(chain) {
  const volumes = volumesFor(chain);
  const { generalStateCID } = await tip(sdk, nodeURL(), chain, volumes);
  return view(volumeLoader(volumes, sdk.decodeDagCbor), generalStateCID);
}

const balanceOf = async (address, chain) => BigInt((await api(`api/state/account/${address}`, chain))?.balance ?? 0);

/** What never changes about an artist chain: who it pays and the rules it runs. Kept for the page's life. */
const chains = new Map();
function chainInfo(name) {
  if (!chains.has(name)) {
    const chain = chainOf(name);
    const pending = (async () => {
      const volumes = volumesFor(chain);
      const [artist, spec] = await Promise.all([
        premineRecipient(sdk, nodeURL(), chain, volumes),
        tip(sdk, nodeURL(), chain, volumes).then((t) => chainSpec(sdk, volumes, t.specCID)),
      ]);
      return { name, chain, artist, spec, fanfare: read.runsFanfare(spec) };
    })();
    pending.catch(() => chains.delete(name));
    chains.set(name, pending);
  }
  return chains.get(name);
}

/** Profile cards from Moniker (Nexus/moniker), or none when the node doesn't serve it. */
let profileState;
async function cardOf(address) {
  if (!address) return {};
  try {
    profileState ??= stateOf(PROFILE());
    return await profiles.getProfile(await profileState, address);
  } catch {
    profileState = undefined;
    return { address };
  }
}
const verdicts = new Map();
function verdictOf(address, card) {
  const key = `${address}|${card?.url ?? ""}`;
  if (!verdicts.has(key)) verdicts.set(key, verify(address, card));
  return verdicts.get(key);
}

const directory = async () => (await api("api/chain/children", HOME()))?.directories ?? [];

// The wallet.

const lattice = () => window.lattice ?? null;
let me = null;

class Said extends Error {}

async function connect() {
  if (!lattice()) throw new Said("Install the Lattice wallet to buy, sell and sign.");
  me = await lattice().connect();
  renderWho();
  return me;
}

/**
 * Sends `w` (`{ actions, payments? }`) on `chain` through the wallet and
 * follows it until it lands or the chain says why it can't. `say(text, kind)`
 * reports progress. Resolves true once it landed.
 */
async function perform(chain, w, say) {
  try {
    if (!me) await connect();
    say("Approve it in your wallet…");
    await wallet.send(lattice(), chain, w);
  } catch (error) {
    if (error instanceof Said) return say(error.message, "bad"), false;
    const why = /refused/i.test(error?.message ?? "")
      ? await explain(await stateOf(chain), w, me, { balance: await balanceOf(me, chain) }).catch(() => [])
      : [];
    say(why.length > 0 ? why.map((w) => w.text).join(" ") : walletMessage(error), "bad");
    return false;
  }
  say("Sent. Waiting for a block…", "wait");
  const deadline = Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const why = await explain(await stateOf(chain), w, me).catch(() => []);
    if (why.length > 0 && why.every((w) => w.reason === "done")) return say("Done.", "good"), true;
    const against = why.filter((w) => w.reason !== "done");
    if (against.length > 0) return say(against.map((w) => w.text).join(" "), "bad"), false;
  }
  say("Sent, not in a block yet. It may still land.", "wait");
  return false;
}

// Drawing.

const $ = (selector, root = document) => root.querySelector(selector);
const main = () => $("main");
let renderId = 0;

function renderWho() {
  const who = $("#who");
  who.innerHTML = me
    ? `<a class="btn ghost small" href="#/me">My tickets</a><span class="chip mono" title="${esc(me)}">${esc(short(me))}</span>`
    : `<button class="btn" type="button" data-act="connect">Connect wallet</button>`;
}

/** A status line under a form; `kind` is "", "wait", "good" or "bad". */
function sayer(el) {
  return (text, kind = "") => {
    el.hidden = false;
    el.className = `status ${kind}`;
    el.textContent = text;
  };
}

const avatar = (card, name) =>
  `<span class="avatar" aria-hidden="true">${esc((card?.name ?? name).slice(0, 1).toUpperCase())}</span>`;

function badge(verdict) {
  if (verdict?.verified) return `<span class="verified" title="${esc(verdict.site)} lists this artist's address">✓ ${esc(verdict.site)}</span>`;
  if (verdict?.site) return `<span class="unverified" title="${esc(verdict.site)} doesn't list this artist's address">${esc(verdict.site)} · not confirmed</span>`;
  return `<span class="unverified">Unverified</span>`;
}

function failure(error, what) {
  return `<div class="empty"><h2>Can't read ${esc(what)}</h2><p class="muted">${esc(error?.message ?? error)}</p>
    <p><button class="btn" type="button" data-act="retry">Try again</button> <button class="btn ghost" type="button" data-act="settings">Choose another node</button></p></div>`;
}

// Home: every artist under the home chain.

async function showHome(id) {
  main().innerHTML = `<section class="hero"><h1>Every artist, their own coin.</h1>
    <p class="muted">Buy tickets, merch and questions with an artist's coin. Hold it, resell it, or mine it.</p>
    <a class="btn primary" href="#/launch">Launch your coin</a></section>
    <h2 class="section">Artists</h2><div class="grid" id="artists"><p class="muted">Reading…</p></div>`;
  let names;
  try {
    names = await directory();
  } catch (error) {
    if (id === renderId) $("#artists").outerHTML = failure(error, settings.home);
    return;
  }
  if (id !== renderId) return;
  if (names.length === 0) {
    $("#artists").innerHTML = `<p class="muted">No artists yet. <a href="#/launch">Be the first.</a></p>`;
    return;
  }
  $("#artists").innerHTML = names.map((name) => `<a class="card artist" href="${artistHref(name)}" data-artist="${esc(name)}">${avatar(null, name)}<span><strong>${esc(name)}</strong><span class="muted small">Reading…</span></span></a>`).join("");
  for (const name of names) {
    (async () => {
      const info = await chainInfo(name);
      const card = await cardOf(info.artist);
      const verdict = await verdictOf(info.artist, card);
      const el = $(`[data-artist="${CSS.escape(name)}"]`);
      if (!el || id !== renderId) return;
      el.innerHTML = `${avatar(card, name)}<span><strong>${esc(card.name ?? name)}</strong><span class="small">${card.name ? `<span class="muted">${esc(name)} · </span>` : ""}${badge(verdict)}</span></span>`;
    })().catch(() => {
      const el = $(`[data-artist="${CSS.escape(name)}"] .small`);
      if (el) el.textContent = "Not served by this node";
    });
  }
}

// An artist's page.

let page; // what the artist page last read, for its forms

async function loadArtist(name) {
  const info = await chainInfo(name);
  const state = await stateOf(info.chain);
  const { artist } = info;
  const [card, listings, mine, coin] = await Promise.all([
    cardOf(artist),
    artist ? read.listings(state, artist) : [],
    me ? balanceOf(me, info.chain) : undefined,
    me ? balanceOf(me, HOME()) : undefined,
  ]);
  const withTickets = await Promise.all(
    listings.map(async (listing) => {
      const tickets = await read.tickets(state, artist, listing.name);
      const extra = listing.kind === "qa" ? { questions: await read.questions(state, artist, listing.name) } : {};
      return { ...listing, tickets, ...summary(listing, tickets), ...extra };
    }),
  );
  const isArtist = me !== null && me === artist;
  const staffList = artist ? await read.staff(state, artist) : [];
  return { ...info, state, card, listings: withTickets, balance: mine, homeBalance: coin, isArtist, staff: staffList };
}

async function showArtist(route, id) {
  main().innerHTML = `<p class="muted">Reading ${esc(route.name)}…</p>`;
  let p;
  try {
    p = await loadArtist(route.name);
  } catch (error) {
    if (id === renderId) main().innerHTML = failure(error, chainOf(route.name).join("/"));
    return;
  }
  if (id !== renderId) return;
  page = p;
  const verdict = await verdictOf(p.artist, p.card);
  if (id !== renderId) return;
  const title = p.card.name ?? p.name;
  document.title = `${title} · Fanfare`;
  const kinds = [["ticket", "Shows"], ["qa", "Q&A"], ["merch", "Merch"]];
  main().innerHTML = `
    <section class="artist-head">
      ${avatar(p.card, p.name)}
      <div><h1>${esc(title)}</h1>
        <p class="small"><span class="mono muted">${esc(p.chain.join("/"))}</span> · ${badge(verdict)}</p>
        ${p.card.description ? `<p>${esc(p.card.description)}</p>` : ""}
      </div>
      <div class="head-acts">${p.isArtist || p.staff.includes(me) ? `<a class="btn" href="#/door/${encodeURIComponent(p.name)}">Door</a>` : ""}${p.isArtist ? `<button class="btn primary" type="button" data-act="new-listing">New listing</button>` : ""}</div>
    </section>
    ${verdict?.verified ? "" : p.isArtist
      ? `<p class="note">To show fans this is really you: put your site in your profile on Moniker, and serve your address, <span class="mono">${esc(p.artist)}</span>, as a line of <span class="mono">https://&lt;your site&gt;/.well-known/lattice</span> (with <span class="mono">Access-Control-Allow-Origin: *</span>).</p>`
      : `<p class="note">Names are first come. Fanfare shows an artist as verified when the site on their profile lists their address.</p>`}
    ${!p.fanfare ? `<p class="note warn">This chain runs its own rules, not Fanfare's. Fanfare can't vouch that its tickets can't be taken back.</p>` : ""}
    ${!p.artist ? `<p class="note warn">This chain's first block paid no one, so Fanfare can't tell whose it is.</p>` : ""}
    <section class="coin card">
      <div><span class="label">Your ${esc(p.name)}</span><strong class="big">${p.balance === undefined ? "—" : coins(p.balance)}</strong></div>
      <div class="coin-acts"><button class="btn" type="button" data-act="buy-coin">Buy ${esc(p.name)}</button>${p.isArtist || (p.balance ?? 0n) > 0n ? `<button class="btn ghost" type="button" data-act="sell-coin">Sell</button>` : ""}</div>
      <div id="market" hidden></div>
    </section>
    ${p.isArtist ? artistTools(p) : ""}
    ${kinds.map(([kind, heading]) => {
      const list = p.listings.filter((l) => l.kind === kind);
      return list.length === 0 ? "" : `<h2 class="section">${heading}</h2>${list.map((l) => listingCard(p, l)).join("")}`;
    }).join("")}
    ${p.listings.length === 0 ? `<div class="empty"><p class="muted">${p.isArtist ? "Nothing on sale yet. Put your first show on sale." : "Nothing on sale yet."}</p></div>` : ""}`;
}

function listingCard(p, l) {
  const [one, many] = unitOf(l.kind);
  const meta = [l.venue, l.date].filter(Boolean).map(esc).join(" · ");
  const sale = l.forSale.slice(0, 6);
  // The artist's own unsold stock is on sale, not "held".
  const mineHeld = me && !p.isArtist ? l.tickets.filter((t) => t.holder === me) : [];
  return `<article class="card listing${l.closed ? " closed" : ""}" id="l-${esc(l.name)}">
    <header><div><h3>${esc(l.title)}</h3>${meta ? `<p class="muted small">${meta}</p>` : ""}</div>
      <p class="small muted">${plural(l.total, one, many)} · ${l.held} held by fans${l.cheapest !== undefined ? ` · from <strong>${coins(l.cheapest)}</strong>` : l.total > 0 ? " · none for sale" : ""}</p></header>
    ${mineHeld.length ? `<p class="small">You hold ${mineHeld.map((t) => `<strong>${esc(seatOf(l.name, t.id))}</strong>`).join(", ")} · <a href="#/me">My tickets</a></p>` : ""}
    ${sale.length ? `<ul class="seats">${sale.map((t) => `<li><span>${esc(seatOf(l.name, t.id))}${t.holder !== p.artist ? ` <span class="tag">resale</span>` : ""}</span><span class="price">${coins(t.price)}</span>${t.holder === me ? `<span class="muted small">${p.isArtist && t.holder === p.artist ? "on sale" : "yours"}</span>` : `<button class="btn small" type="button" data-act="buy" data-listing="${esc(l.name)}" data-ticket="${esc(t.id)}">${l.kind === "qa" ? "Buy and ask" : "Buy"}</button>`}</li>`).join("")}</ul>` : ""}
    ${l.kind === "qa" ? qaBlock(p, l) : ""}
    <div class="form-slot"></div>
  </article>`;
}

function qaBlock(p, l) {
  const answered = l.questions.filter((q) => q.answer !== undefined);
  const waiting = l.questions.filter((q) => q.answer === undefined);
  return `${answered.length ? `<div class="qa">${answered.map((q) => `<div class="q"><p class="ask">${esc(q.text)}</p><p class="answer">${esc(q.answer)}</p></div>`).join("")}</div>` : ""}
    ${p.isArtist && waiting.length ? `<h4>Waiting for you</h4>${waiting.map((q) => `<form class="q answer-form" data-act="answer" data-ticket="${esc(q.ticket.id)}"><p class="ask">${esc(q.text)} <span class="muted small">· ${esc(short(q.ticket.holder))}</span></p><label class="sr-only" for="a-${esc(q.ticket.id)}">Your answer</label><textarea id="a-${esc(q.ticket.id)}" name="answer" rows="2" required placeholder="Your answer"></textarea><button class="btn primary small" type="submit">Answer</button><p class="status" hidden></p></form>`).join("")}`
      : waiting.length ? `<p class="small muted">${plural(waiting.length, "question")} waiting for an answer.</p>` : ""}`;
}

function artistTools(p) {
  const merch = p.listings.filter((l) => l.kind === "merch");
  return `<section class="card tools"><h2>Your page</h2>
    <div class="tool-row"><span>Door staff: ${p.staff.length ? p.staff.map((s) => `<span class="mono">${esc(short(s))}</span>`).join(", ") : "only you"}</span><button class="btn small ghost" type="button" data-act="add-staff">Add staff</button></div>
    ${merch.length ? `<div class="tool-row"><span>Shipping addresses are sealed to a key your wallet makes.</span><button class="btn small ghost" type="button" data-act="shipping">Open addresses</button></div><div id="shipping" hidden></div>` : ""}
    <div class="form-slot"></div>
  </section>`;
}

/** Opens a small form in a card's slot, closing any other. */
function openForm(slot, html) {
  for (const open of document.querySelectorAll(".form-slot.open")) {
    open.classList.remove("open");
    open.innerHTML = "";
  }
  slot.classList.add("open");
  slot.innerHTML = html;
  slot.querySelector("input, textarea, select, button")?.focus();
  return slot;
}

function buyForm(button) {
  const l = page.listings.find((x) => x.name === button.dataset.listing);
  const t = l?.tickets.find((x) => x.id === button.dataset.ticket);
  if (!t) return;
  const card = button.closest(".listing");
  const extra = l.kind === "qa"
    ? `<label for="ask">Your question</label><textarea id="ask" name="question" rows="3" required></textarea>`
    : l.kind === "merch"
      ? `<fieldset><legend>Ship to</legend><input name="name" placeholder="Name" required autocomplete="name"><input name="line1" placeholder="Address" required autocomplete="address-line1"><input name="line2" placeholder="Apartment, suite (optional)" autocomplete="address-line2"><div class="row"><input name="city" placeholder="City" required autocomplete="address-level2"><input name="postcode" placeholder="Postcode" autocomplete="postal-code"></div><input name="country" placeholder="Country" required autocomplete="country-name"><p class="small muted">Sealed to the artist: only their wallet opens it.</p></fieldset>`
      : "";
  openForm($(".form-slot", card), `<form class="inline" data-act="confirm-buy" data-listing="${esc(l.name)}" data-ticket="${esc(t.id)}">
    <p><strong>${esc(l.title)} · ${esc(seatOf(l.name, t.id))}</strong> for <strong>${coins(t.price)} ${esc(page.name)}</strong>${t.holder !== page.artist ? ` <span class="muted small">resold by ${esc(short(t.holder))}</span>` : ""}, plus a fee of 1.
    ${page.balance !== undefined && page.balance < t.price + 1n ? `<br><span class="warn-text">You have ${coins(page.balance)} ${esc(page.name)}. <button class="linkish" type="button" data-act="buy-coin">Buy ${esc(page.name)}</button></span>` : ""}</p>
    ${extra}
    <div class="acts"><button class="btn primary" type="submit">Buy in wallet</button><button class="btn ghost" type="button" data-act="close-form">Cancel</button></div>
    <p class="status" hidden></p></form>`);
}

async function confirmBuy(form) {
  const say = sayer($(".status", form));
  const l = page.listings.find((x) => x.name === form.dataset.listing);
  const seen = l?.tickets.find((x) => x.id === form.dataset.ticket);
  if (!me) await connect().catch((e) => say(e.message, "bad"));
  if (!me) return;
  if (seen.holder === me) return say("This one is already yours.", "bad");
  const w = write.buy(seen, me);
  const data = new FormData(form);
  if (l.kind === "qa") {
    w.actions.push(...(await write.changes(page.state, write.question(me, page.artist, seen.id, String(data.get("question")).trim()))));
  }
  if (l.kind === "merch") {
    const key = page.artist && (await profiles.getField(await (profileState ??= stateOf(PROFILE())), page.artist, ship.KEY_FIELD).catch(() => undefined));
    if (!key) return say("The artist hasn't set up shipping yet, so an address can't be sealed to them.", "bad");
    const address = Object.fromEntries([...data].filter(([, v]) => String(v).trim() !== "").map(([k, v]) => [k, String(v).trim()]));
    w.actions.push(...(await write.changes(page.state, write.ship(me, page.artist, seen.id, await ship.seal(key, address)))));
  }
  setBusy(form, true);
  if (await perform(page.chain, w, say)) setTimeout(rerender, 800);
  setBusy(form, false);
}

const setBusy = (form, busy) => form.querySelectorAll("button, input, textarea, select").forEach((el) => (el.disabled = busy));

function newListingForm() {
  openForm($(".tools .form-slot"), `<form class="inline" data-act="create-listing">
    <h3>New listing</h3>
    <div class="kinds" role="radiogroup" aria-label="What are you selling?">${[["ticket", "Show tickets"], ["qa", "Q&A slots"], ["merch", "Merch"]].map(([k, label], i) => `<label class="pill"><input type="radio" name="kind" value="${k}"${i === 0 ? " checked" : ""}>${label}</label>`).join("")}</div>
    <label for="nl-title">Title</label><input id="nl-title" name="title" required placeholder="Berlin">
    <div class="row"><span><label for="nl-venue">Venue</label><input id="nl-venue" name="venue" placeholder="Tresor"></span><span><label for="nl-date">Date</label><input id="nl-date" name="date" type="date"></span></div>
    <div class="row"><span><label for="nl-count">How many</label><input id="nl-count" name="count" inputmode="numeric" value="100" required></span><span><label for="nl-price">Price, in ${esc(page.name)}</label><input id="nl-price" name="price" inputmode="numeric" value="250" required></span></div>
    <p class="small muted">Fans see every ticket you mint, so they know how many exist. Once sold, a ticket is the fan's: they can give it away or resell it, and you can't take it back.</p>
    <div class="acts"><button class="btn primary" type="submit">Put them on sale</button><button class="btn ghost" type="button" data-act="close-form">Cancel</button></div>
    <p class="status" hidden></p></form>`);
}

async function createListing(form) {
  const say = sayer($(".status", form));
  const data = Object.fromEntries(new FormData(form));
  const count = Number(amountIn(data.count) ?? 0n);
  const price = amountIn(data.price);
  if (count < 1 || count > 500) return say("Mint between 1 and 500 at a time.", "bad");
  if (price === undefined) return say("The price is a whole number above zero.", "bad");
  const title = data.title.trim();
  let name = slug(title);
  const taken = new Set(page.listings.map((l) => l.name));
  for (let n = 2; taken.has(name); n++) name = `${slug(title)}-${n}`;
  if (!isItemName(name)) return say("Give it a title with letters or digits.", "bad");
  const record = { kind: data.kind, title, ...(data.venue.trim() && { venue: data.venue.trim() }), ...(data.date && { date: data.date }) };
  const ids = newIds(name, [], count);
  const writes = [...write.listing(page.artist, name, record), ...ids.flatMap((id) => write.mint(page.artist, id, { price }))];
  setBusy(form, true);
  if (await perform(page.chain, { actions: await write.changes(page.state, writes) }, say)) setTimeout(rerender, 800);
  setBusy(form, false);
}

async function answer(form) {
  const say = sayer($(".status", form));
  const text = new FormData(form).get("answer").trim();
  if (!text) return;
  setBusy(form, true);
  if (await perform(page.chain, { actions: await write.changes(page.state, write.answer(page.artist, form.dataset.ticket, text)) }, say)) setTimeout(rerender, 800);
  setBusy(form, false);
}

function staffForm() {
  openForm($(".tools .form-slot"), `<form class="inline" data-act="save-staff"><label for="staff">Their Lattice address</label><input id="staff" name="staff" class="mono" required placeholder="bafyrei…"><p class="small muted">Staff can check tickets in at your door. They pay a fee of 1 for each check-in.</p><div class="acts"><button class="btn primary" type="submit">Add</button><button class="btn ghost" type="button" data-act="close-form">Cancel</button></div><p class="status" hidden></p></form>`);
}

async function saveStaff(form) {
  const say = sayer($(".status", form));
  const address = new FormData(form).get("staff").trim();
  if (!profiles.isAddress(address)) return say("That isn't a Lattice address.", "bad");
  setBusy(form, true);
  if (await perform(page.chain, { actions: await write.changes(page.state, write.staff(page.artist, address)) }, say)) setTimeout(rerender, 800);
  setBusy(form, false);
}

async function openShipping() {
  const box = $("#shipping");
  box.hidden = false;
  const say = (text) => (box.innerHTML = `<p class="small muted">${esc(text)}</p>`);
  say("Approve in your wallet to open addresses…");
  let key;
  try {
    key = await ship.artistKey(lattice());
  } catch (error) {
    return say(walletMessage(error));
  }
  const published = await profiles.getField(await (profileState ??= stateOf(PROFILE())), page.artist, ship.KEY_FIELD).catch(() => undefined);
  const rows = [];
  for (const l of page.listings.filter((x) => x.kind === "merch")) {
    for (const { ticket, sealed } of await read.shipments(page.state, page.artist, l.name)) {
      const address = await ship.open(key.privateKey, sealed);
      rows.push(`<li><strong>${esc(l.title)} · ${esc(seatOf(l.name, ticket.id))}</strong> <span class="mono muted">${esc(short(ticket.holder))}</span><br>${address ? Object.values(address).map(esc).join(", ") : `<span class="muted">Sealed to another key</span>`}</li>`);
    }
  }
  box.innerHTML = `${published === key.publicKey ? "" : `<p class="note">Fans can't send you addresses until your key is on your profile. <button class="btn small" type="button" data-act="publish-key" data-key="${esc(key.publicKey)}">Put it on your profile</button></p><p class="status" hidden></p>`}
    ${rows.length ? `<ul class="addresses">${rows.join("")}</ul>` : `<p class="small muted">No addresses yet.</p>`}`;
}

async function publishKey(button) {
  const say = sayer(button.closest(".note").nextElementSibling);
  const state = await (profileState ??= stateOf(PROFILE()));
  const w = await profiles.setField(state, page.artist, ship.KEY_FIELD, button.dataset.key);
  button.disabled = true;
  if (await perform(PROFILE(), w, say)) profileState = undefined;
  button.disabled = false;
}

// The coin market.

async function showMarket(selling) {
  const box = $("#market");
  box.hidden = false;
  if (selling) {
    box.innerHTML = `<form class="inline" data-act="sell-coin-confirm"><p class="small muted">Offer ${esc(page.name)} for Fanfare coin. Anyone can take the whole offer; your wallet locks the coin until then.</p>
      <div class="row"><span><label for="sell-coin">${esc(page.name)} to sell</label><input id="sell-coin" name="coin" inputmode="numeric" required></span><span><label for="sell-price">Fanfare coin you want</label><input id="sell-price" name="price" inputmode="numeric" required></span></div>
      <div class="acts"><button class="btn primary" type="submit">Offer in wallet</button></div><p class="status" hidden></p></form>`;
    return;
  }
  box.innerHTML = `<p class="small muted">Reading offers…</p>`;
  let offers;
  try {
    offers = await market.offers(nodeURL(), page.chain);
  } catch (error) {
    box.innerHTML = `<p class="small warn-text">${esc(error.message)}</p>`;
    return;
  }
  box.innerHTML = offers.length === 0
    ? `<p class="small muted">Nobody is selling ${esc(page.name)} right now. You can also earn it by mining ${esc(page.chain.join("/"))}.</p>`
    : `<form class="inline" data-act="buy-coin-confirm"><table class="offers"><thead><tr><th>${esc(page.name)}</th><th>for</th><th>each</th></tr></thead><tbody>${offers.slice(0, 8).map((o) => `<tr><td>${coins(o.coin)}</td><td>${coins(o.price)}</td><td class="muted">${(Number(o.price) / Number(o.coin)).toPrecision(3)}</td></tr>`).join("")}</tbody></table>
      <label for="want">How much ${esc(page.name)}?</label><input id="want" name="want" inputmode="numeric" required>
      ${page.homeBalance !== undefined ? `<p class="small muted">You have ${coins(page.homeBalance)} Fanfare coin.</p>` : ""}
      <div class="acts"><button class="btn primary" type="submit">Buy in wallet</button></div><p class="status" hidden></p></form>`;
  box.offers = offers;
}

function buyCoin(form) {
  const say = sayer($(".status", form));
  const want = amountIn(new FormData(form).get("want"));
  if (want === undefined) return say("A whole number above zero.", "bad");
  const picked = market.pick(form.closest("#market").offers, want);
  if (!picked) return say(`Offers hold less than ${coins(want)} ${page.name} in all.`, "bad");
  say(`Taking ${plural(picked.offers.length, "offer")}: ${coins(picked.coin)} ${page.name} for ${coins(picked.price)} Fanfare coin. Your wallet takes it from here.`, "wait");
  location.href = market.buyRequest(page.chain, picked.offers);
}

function sellCoin(form) {
  const say = sayer($(".status", form));
  const data = new FormData(form);
  const [coin, price] = [amountIn(data.get("coin")), amountIn(data.get("price"))];
  if (coin === undefined || price === undefined) return say("Whole numbers above zero.", "bad");
  say("Your wallet takes it from here.", "wait");
  location.href = market.sellRequest(page.chain, coin, price);
}

// My tickets: what the connected account holds on every artist chain.

async function showMine(id) {
  if (!me) {
    main().innerHTML = `<div class="empty"><h1>My tickets</h1><p class="muted">Connect your wallet to see what you hold.</p><button class="btn primary" type="button" data-act="connect">Connect wallet</button></div>`;
    return;
  }
  main().innerHTML = `<h1>My tickets</h1><div id="mine"><p class="muted">Reading…</p></div>`;
  const found = [];
  for (const name of await directory().catch(() => [])) {
    try {
      const info = await chainInfo(name);
      if (!info.artist) continue;
      const state = await stateOf(info.chain);
      const held = await read.held(state, info.artist, me);
      if (held.length === 0) continue;
      const listings = await read.listings(state, info.artist);
      found.push({ info, state, held, listings, balance: await balanceOf(me, info.chain) });
    } catch {}
  }
  if (id !== renderId) return;
  mineCache = found;
  $("#mine").innerHTML = found.length === 0
    ? `<p class="muted">Nothing yet. <a href="#/">Find an artist.</a></p>`
    : found.map(({ info, held, listings, balance }) => `<section class="card"><header><h2><a href="${artistHref(info.name)}">${esc(info.name)}</a></h2><span class="muted small">${coins(balance)} ${esc(info.name)}</span></header>
      <ul class="held">${held.map((t) => {
        const l = listings.find((x) => t.id === x.name || t.id.startsWith(`${x.name}/`));
        return `<li data-chain="${esc(info.name)}" data-ticket="${esc(t.id)}"><div><strong>${esc(l?.title ?? t.id)}</strong> · ${esc(l ? seatOf(l.name, t.id) : t.id)}${l?.date ? ` <span class="muted small">${esc(l.date)}</span>` : ""}
          ${t.price !== undefined ? `<span class="tag">for sale at ${coins(t.price)}</span>` : ""}</div>
          <div class="acts">${l?.kind !== "merch" && l?.kind !== "qa" ? `<button class="btn small primary" type="button" data-act="pass">Show pass</button>` : ""}<button class="btn small" type="button" data-act="resell">${t.price !== undefined ? "Change price" : "Sell"}</button><button class="btn small ghost" type="button" data-act="give">Give</button></div><div class="form-slot"></div></li>`;
      }).join("")}</ul></section>`).join("");
}
let mineCache = [];
const heldRow = (el) => {
  const row = el.closest("li[data-ticket]");
  const entry = mineCache.find((x) => x.info.name === row.dataset.chain);
  return { row, entry, ticket: entry?.held.find((t) => t.id === row.dataset.ticket) };
};

async function showPass(button) {
  const { row, entry, ticket } = heldRow(button);
  const slot = openForm($(".form-slot", row), `<div class="pass"><p class="small muted">Approve in your wallet…</p></div>`);
  try {
    const code = await door.pass(lattice(), entry.info.artist, ticket.id);
    const qr = qrcode(0, "L");
    qr.addData(code);
    qr.make();
    slot.innerHTML = `<div class="pass">${qr.createSvgTag({ cellSize: 4, margin: 4, scalable: true })}<p class="small muted">Show this at the door. It works for two minutes; then make a new one.</p><button class="btn small ghost" type="button" data-act="close-form">Done</button></div>`;
  } catch (error) {
    slot.innerHTML = `<p class="status bad">${esc(walletMessage(error))}</p>`;
  }
}

function resellForm(button) {
  const { row, entry, ticket } = heldRow(button);
  openForm($(".form-slot", row), `<form class="inline" data-act="resell-confirm"><label for="rp">Price, in ${esc(entry.info.name)}</label><input id="rp" name="price" inputmode="numeric" value="${ticket.price ?? ""}"><p class="small muted">Anyone can buy it at this price, at once. Leave it empty to take it off sale.</p><div class="acts"><button class="btn primary" type="submit">Save in wallet</button><button class="btn ghost" type="button" data-act="close-form">Cancel</button></div><p class="status" hidden></p></form>`);
}

async function resell(form) {
  const { entry, ticket } = heldRow(form);
  const say = sayer($(".status", form));
  const text = new FormData(form).get("price").trim();
  const price = text === "" ? undefined : amountIn(text);
  if (text !== "" && price === undefined) return say("A whole number above zero, or empty.", "bad");
  setBusy(form, true);
  if (await perform(entry.info.chain, { actions: [write.price(ticket, price)] }, say)) setTimeout(rerender, 800);
  setBusy(form, false);
}

function giveForm(button) {
  const { row } = heldRow(button);
  openForm($(".form-slot", row), `<form class="inline" data-act="give-confirm"><label for="to">Their Lattice address</label><input id="to" name="to" class="mono" required placeholder="bafyrei…"><p class="small muted">It's theirs once it lands; you can't take it back.</p><div class="acts"><button class="btn primary" type="submit">Give in wallet</button><button class="btn ghost" type="button" data-act="close-form">Cancel</button></div><p class="status" hidden></p></form>`);
}

async function give(form) {
  const { entry, ticket } = heldRow(form);
  const say = sayer($(".status", form));
  const to = new FormData(form).get("to").trim();
  if (!profiles.isAddress(to)) return say("That isn't a Lattice address.", "bad");
  setBusy(form, true);
  if (await perform(entry.info.chain, { actions: [write.transfer(ticket, to)] }, say)) setTimeout(rerender, 800);
  setBusy(form, false);
}

// The door.

let scanning = null;
function stopScan() {
  scanning?.stop();
  scanning = null;
}

async function showDoor(route, id) {
  let info;
  try {
    info = await chainInfo(route.name);
  } catch (error) {
    if (id === renderId) main().innerHTML = failure(error, chainOf(route.name).join("/"));
    return;
  }
  if (id !== renderId) return;
  main().innerHTML = `<a class="back" href="${artistHref(route.name)}">← ${esc(route.name)}</a><h1>Door</h1>
    <p class="muted">Scan a fan's pass. ${me ? "" : "Connect the wallet you check people in with."}</p>
    <div class="door card"><video id="camera" playsinline muted hidden></video>
      <div class="acts"><button class="btn primary" type="button" data-act="camera">Use camera</button></div>
      <form data-act="check-pass" class="inline"><label for="code">Or paste a pass</label><textarea id="code" name="code" rows="3" class="mono"></textarea><button class="btn" type="submit">Check</button></form>
      <div id="verdict" aria-live="assertive"></div></div>`;
  page = { ...info };
}

async function startCamera(button) {
  if (!("BarcodeDetector" in window)) return showVerdict({ ok: false, text: "This browser can't read QR codes from the camera. Paste the pass instead." });
  const video = $("#camera");
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
    video.srcObject = stream;
    video.hidden = false;
    await video.play();
    button.hidden = true;
    const detector = new window.BarcodeDetector({ formats: ["qr_code"] });
    let stopped = false;
    scanning = { stop: () => ((stopped = true), stream.getTracks().forEach((t) => t.stop())) };
    let last = "";
    while (!stopped) {
      const [code] = await detector.detect(video).catch(() => []);
      if (code && code.rawValue !== last) {
        last = code.rawValue;
        await checkPass(code.rawValue);
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  } catch (error) {
    showVerdict({ ok: false, text: `The camera didn't start: ${error.message}` });
  }
}

function showVerdict(v, actions = "") {
  $("#verdict").innerHTML = `<div class="verdict ${v.ok ? "good" : "bad"}"><strong>${v.ok ? "Let them in" : "Stop"}</strong><p>${esc(v.text)}</p>${actions}<p class="status" hidden></p></div>`;
}

let checked;
async function checkPass(code) {
  const scanned = door.readPass(code.trim());
  if (!scanned) return showVerdict({ ok: false, text: "That isn't a Fanfare pass." });
  if (scanned.artist !== page.artist) return showVerdict({ ok: false, text: "This pass is for another artist's ticket." });
  const state = await stateOf(page.chain);
  const ticket = await read.ticket(state, page.artist, scanned.id);
  const v = await door.check(sdk, ORIGIN, scanned, ticket, ticket ? await read.checkins(state, page.artist, ticket.id) : []);
  checked = v.ok ? ticket : undefined;
  showVerdict(v.ok ? { ok: true, text: `Ticket ${scanned.id}, held by ${short(ticket.holder)}.` } : v,
    v.ok ? `<button class="btn primary" type="button" data-act="checkin">Check in</button>` : "");
}

async function checkIn(button) {
  const say = sayer(button.parentElement.querySelector(".status"));
  const state = await stateOf(page.chain);
  button.disabled = true;
  if (!me) await connect().catch((e) => say(e.message, "bad"));
  if (me && me !== page.artist && !(await read.staff(state, page.artist)).includes(me)) {
    button.disabled = false;
    return say("This wallet isn't on the artist's door staff, so its check-in won't count.", "bad");
  }
  await perform(page.chain, { actions: await write.changes(state, write.checkin(me, page.artist, checked.id)) }, say);
}

// Launch.

function showLaunch() {
  main().innerHTML = `<a class="back" href="#/">← Fanfare</a><h1>Launch your coin</h1>
    <form class="card launch" data-act="launch-command">
      <label for="ln">Your name</label><input id="ln" name="name" required autocomplete="off" placeholder="band" pattern="[A-Za-z0-9][A-Za-z0-9_-]*">
      <p class="small muted">Fans find you by this name. It's first come, first served. Your chain will be <span class="mono" id="ln-path">${esc(settings.home)}/…</span></p>
      <p class="defaults" id="ln-defaults">You get <strong>${coins(launch.premineAmount(launch.defaults))}</strong> of your coin at launch. Miners earn ${coins(launch.defaults.initialReward)} a block after that, halving every ${coins(launch.defaults.halvingInterval)} blocks. <button class="linkish" type="button" data-act="change-defaults">Change</button></p>
      <div id="ln-change" hidden><div class="row"><span><label for="ln-premine">Blocks of rewards to you at launch</label><input id="ln-premine" name="premine" inputmode="numeric" value="${launch.defaults.premine}"></span><span><label for="ln-reward">Reward per block</label><input id="ln-reward" name="initialReward" inputmode="numeric" value="${launch.defaults.initialReward}"></span><span><label for="ln-halving">Halving every</label><input id="ln-halving" name="halvingInterval" inputmode="numeric" value="${launch.defaults.halvingInterval}"></span></div></div>
      <div class="acts"><button class="btn primary" type="submit">Launch</button></div>
      <p class="status" hidden></p>
      <div id="ln-steps" hidden></div>
    </form>`;
}

function launchSpec(form) {
  const data = Object.fromEntries(new FormData(form));
  const changes = {};
  for (const field of ["premine", "initialReward", "halvingInterval"]) {
    const value = String(data[field] ?? "").trim();
    if (!/^[0-9]+$/.test(value)) return undefined;
    changes[field] = Number(value);
  }
  return launch.spec(changes);
}

async function launchCommand(form) {
  const say = sayer($(".status", form));
  const name = new FormData(form).get("name").trim();
  if (!isArtistName(name)) return say("Letters, digits, - and _, starting with a letter or digit.", "bad");
  const spec = launchSpec(form);
  if (!spec || spec.halvingInterval < 1) return say("Whole numbers, and a halving interval above zero.", "bad");
  if ((await directory().catch(() => [])).includes(name)) return say(`${name} is taken. Names are first come.`, "bad");
  if (!me) await connect().catch((e) => say(e.message, "bad"));
  if (!me) return;
  say("");
  $(".status", form).hidden = true;
  const file = `${name}.json`;
  const blob = URL.createObjectURL(new Blob([JSON.stringify(spec, null, 2)], { type: "application/json" }));
  const steps = $("#ln-steps");
  steps.hidden = false;
  steps.innerHTML = `<p>Your chain starts on your own node, and its first block pays ${coins(launch.premineAmount(spec))} ${esc(name)} to your wallet, <span class="mono">${esc(short(me))}</span>.</p>
    <ol><li>Save <a href="${blob}" download="${esc(file)}">${esc(file)}</a> and <a href="./fanfare_policy.wasm" download>fanfare_policy.wasm</a>.</li>
    <li>Run, on your node:<pre class="mono">${esc(`lattice child create ${settings.home}   # once, if your node doesn't host it\nlattice ${launch.createArguments({ name, specFile: file, moduleFile: "fanfare_policy.wasm", artist: me }).join(" ")}`)}</pre></li>
    <li>Your node mines your chain's first block with its next one. Then <a href="${artistHref(name)}">open your page</a> and put your first show on sale.</li></ol>`;
}

// Settings.

function openSettings() {
  const dialog = $("#settings");
  dialog.querySelector("[name=node]").value = settings.node;
  dialog.querySelector("[name=home]").value = settings.home;
  dialog.querySelector("[name=profile]").value = settings.profile;
  dialog.showModal();
}

function saveSettings(form) {
  const data = Object.fromEntries(new FormData(form));
  Object.assign(settings, { node: data.node.trim(), home: data.home.trim() || DEFAULTS.home, profile: data.profile.trim() || DEFAULTS.profile });
  store.set("settings", settings);
  chains.clear();
  verdicts.clear();
  profileState = undefined;
  $("#settings").close();
  rerender();
}

// Routing and events.

function rerender() {
  stopScan();
  const id = ++renderId;
  const route = parseRoute(location.hash);
  document.title = "Fanfare";
  for (const a of document.querySelectorAll("header nav a")) a.setAttribute("aria-current", a.getAttribute("href") === `#/${route.view === "home" ? "" : route.view}` ? "page" : "false");
  if (!settings.node) {
    main().innerHTML = `<div class="empty"><h1>Choose a node</h1><p class="muted">Fanfare reads every record from a Lattice node and checks it here. Point it at yours, or any node that hosts ${esc(settings.home)}.</p><button class="btn primary" type="button" data-act="settings">Choose a node</button></div>`;
    return;
  }
  const views = { home: showHome, artist: showArtist, me: showMine, door: showDoor, launch: showLaunch };
  Promise.resolve(views[route.view](route.view === "home" || route.view === "me" ? id : route, id)).catch((error) => {
    if (id === renderId) main().innerHTML = failure(error, "this page");
  });
}

const clicks = {
  connect: () => connect().then(rerender).catch((e) => alertLine(e instanceof Said ? e.message : walletMessage(e))),
  settings: openSettings,
  retry: rerender,
  "close-form": (el) => {
    const slot = el.closest(".form-slot");
    slot.classList.remove("open");
    slot.innerHTML = "";
  },
  buy: buyForm,
  "new-listing": newListingForm,
  "add-staff": staffForm,
  shipping: openShipping,
  "publish-key": publishKey,
  "buy-coin": () => showMarket(false),
  "sell-coin": () => showMarket(true),
  pass: showPass,
  resell: resellForm,
  give: giveForm,
  camera: startCamera,
  checkin: checkIn,
  "change-defaults": () => {
    $("#ln-change").hidden = false;
    $("#ln-defaults").hidden = true;
  },
};
const submits = {
  "confirm-buy": confirmBuy,
  "create-listing": createListing,
  answer,
  "save-staff": saveStaff,
  "buy-coin-confirm": buyCoin,
  "sell-coin-confirm": sellCoin,
  "resell-confirm": resell,
  "give-confirm": give,
  "check-pass": (form) => checkPass(new FormData(form).get("code")),
  "launch-command": launchCommand,
  settings: saveSettings,
};

function alertLine(text) {
  const line = $("#alert");
  line.textContent = text;
  line.hidden = false;
  setTimeout(() => (line.hidden = true), 6000);
}

document.addEventListener("click", (event) => {
  const el = event.target.closest("[data-act]");
  if (!el || el.tagName === "FORM" || !clicks[el.dataset.act]) return;
  event.preventDefault();
  Promise.resolve(clicks[el.dataset.act](el)).catch((error) => alertLine(error.message));
});
document.addEventListener("submit", (event) => {
  const form = event.target;
  if (!submits[form.dataset.act]) return;
  event.preventDefault();
  Promise.resolve(submits[form.dataset.act](form)).catch((error) => alertLine(error.message));
});
document.addEventListener("input", (event) => {
  if (event.target.id === "ln") $("#ln-path").textContent = `${settings.home}/${event.target.value || "…"}`;
});
window.addEventListener("hashchange", rerender);

async function boot() {
  // The wallet injects `window.lattice` as the page loads; it may come just after.
  if (!lattice()) await new Promise((resolve) => {
    window.addEventListener("lattice#initialized", resolve, { once: true });
    setTimeout(resolve, 500);
  });
  me = (await lattice()?.address().catch(() => null)) ?? null;
  renderWho();
  rerender();
}
boot();
