// Fanfare in the browser. Every record is read by CID from the node in
// Settings and checked here; every write and signature is the Lattice
// wallet's (`window.lattice`), approved by the person in the wallet's own
// window. The page keeps no key and no server.
//
// An artist sells in one of two places. Most sell on the Fanfare chain
// itself, priced in its coin (FAN), from nothing but their wallet: their
// key is `@<address>`. An artist who launched their own coin sells on their
// own chain under it, priced in that coin: their key is the chain's name.
import * as sdk from "./vendor/lattice-sdk.js";
import { mediaVolume, operator } from "./vendor/media.mjs";
import qrcode from "./vendor/qrcode.mjs";
import * as profiles from "./vendor/profile.mjs";
import * as door from "../client/door.mjs";
import * as launch from "../client/launch.mjs";
import * as market from "../client/market.mjs";
import * as read from "../client/read.mjs";
import { explain, landed } from "../client/refusal.mjs";
import { chainSpec, premineRecipient, tip, view, volumeLoader } from "../client/state.mjs";
import { verify } from "../client/verify.mjs";
import * as wallet from "../client/wallet.mjs";
import * as write from "../client/write.mjs";
import {
  amountIn, artistHref, byDate, coins, dateText, doorHref, esc, isArtistName, isItemName, newIds, parseRoute, plural, sellerAddress, sellerKey,
  short, slug, summary, today, walletMessage,
} from "./lib.mjs";

// Settings, kept in this browser only.

// The public trial on testnet; Nexus/fanfare and Nexus/moniker once they launch.
const DEFAULTS = {
  node: "https://lattice-testnet-apps-iad.fly.dev",
  home: "Nexus/testnet/fanfare-a5688b",
  profile: "Nexus/testnet/moniker-da6f57",
  origins: "",
  // The artist's own node, which keeps their show images.
  ownNode: "",
  ownCookie: "",
};
/** Where an artist edits their name and picture. */
const MONIKER_APP = "https://adalinxx.github.io/moniker/app/";
/** The Fanfare chain's coin, as prices show it. */
const FAN = "FAN";
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
  const asked = new URLSearchParams(location.search);
  for (const key of ["node", "home", "profile"]) if (asked.get(key)) settings[key] = asked.get(key);
}
const nodeURL = () => settings.node.replace(/\/+$/, "");
const HOME = () => settings.home.split("/");
const PROFILE = () => settings.profile.split("/");
const chainOf = (name) => [...HOME(), name];
const ORIGIN = location.origin;
const money = (amount, unit) => `${coins(amount)} ${esc(unit)}`;

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

// Show images: a file kept by the artist's own node as a Volume, named in the
// show's record by CID (vendor/media.mjs). The page reads it through the
// node, checks it against the CID, and shows only raster images: an SVG is a
// document that can run script.
const IMAGE_TYPES = /^image\/(png|jpeg|gif|webp|avif)$/;
const IMAGE_MAX = 2_000_000;
const images = new Map();
function imageURL(chain, cid) {
  const key = `${chain.join("/")}|${cid}`;
  if (!images.has(key)) {
    const pending = (async () => {
      const volume = await volumesFor(chain).get(cid);
      const file = sdk.decodeDagCbor(volume.bytes(cid));
      if (typeof file?.type !== "string" || !IMAGE_TYPES.test(file.type) || !(file.bytes instanceof Uint8Array) || file.bytes.length > IMAGE_MAX) return null;
      return URL.createObjectURL(new Blob([file.bytes], { type: file.type }));
    })().catch(() => {
      images.delete(key);
      return null;
    });
    images.set(key, pending);
  }
  return images.get(key);
}
/** A show's image, filled in once it's read; nothing when the show has none. */
const imageTag = (chain, cid, cls) => (cid ? `<img class="${cls}" data-media="${esc(cid)}" data-chain="${esc(chain.join("/"))}" alt="">` : "");
function showImages(root) {
  for (const img of root.querySelectorAll("img[data-media]:not([data-asked])")) {
    img.dataset.asked = "1";
    imageURL(img.dataset.chain.split("/"), img.dataset.media).then((url) => (url ? (img.src = url) : img.remove()));
  }
}

/** The rules a chain runs, read once for the page's life. */
function specOf(chain) {
  const volumes = volumesFor(chain);
  return tip(sdk, nodeURL(), chain, volumes).then((t) => chainSpec(sdk, volumes, t.specCID));
}

/**
 * What never changes about an artist (see the top): `{ key, chain, artist,
 * coin, own, name?, fanfare }`. Kept for the page's life.
 */
const sellers = new Map();
function sellerInfo(key) {
  if (!sellers.has(key)) {
    const address = sellerAddress(key);
    const pending = address
      ? homeInfo().then((home) => ({ key, chain: HOME(), artist: address, coin: FAN, own: false, fanfare: home.fanfare }))
      : (async () => {
          if (!isArtistName(key)) throw new Error(`${key} isn't an artist's name`);
          const chain = chainOf(key);
          const [artist, spec] = await Promise.all([premineRecipient(sdk, nodeURL(), chain, volumesFor(chain)), specOf(chain)]);
          return { key, name: key, chain, artist, coin: key, own: true, fanfare: read.runsFanfare(spec) };
        })();
    pending.catch(() => sellers.delete(key));
    sellers.set(key, pending);
  }
  return sellers.get(key);
}
let homePending;
function homeInfo() {
  homePending ??= specOf(HOME()).then((spec) => ({ fanfare: read.runsFanfare(spec) }));
  homePending.catch(() => (homePending = undefined));
  return homePending;
}

/** Profile cards from Moniker, or a bare one when the node doesn't serve it. */
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
/** What fans call an artist: their Moniker name, else their chain's name or a short address. */
const nameOf = (info, card) => card?.name ?? info.name ?? short(info.artist);

/** The artists with their own coin: the chains under the Fanfare chain. */
const directory = async () => (await api("api/chain/children", HOME()))?.directories ?? [];

/**
 * Every artist and listing Fanfare can see: on the Fanfare chain, and on
 * each artist's own chain. `[{ info, listings, state }]`; an artist chain
 * the node doesn't serve is left out.
 */
async function everyone() {
  const homeState = await stateOf(HOME());
  const byArtist = new Map();
  for (const l of (await read.allListings(homeState)).filter((x) => x.kind === "ticket")) byArtist.set(l.artist, [...(byArtist.get(l.artist) ?? []), l]);
  const shared = await Promise.all([...byArtist].map(async ([address, listings]) => ({ info: await sellerInfo(sellerKey(address)), listings, state: homeState })));
  const own = await Promise.all(
    (await directory().catch(() => [])).map(async (name) => {
      try {
        const info = await sellerInfo(name);
        const state = await stateOf(info.chain);
        return { info, listings: info.artist ? (await read.listings(state, info.artist)).filter((l) => l.kind === "ticket") : [], state };
      } catch {
        return undefined;
      }
    }),
  );
  return [...shared, ...own.filter(Boolean)];
}

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
  // What the chain says about `w` now, or [] (nothing known yet) when the node can't answer.
  const ask = async (options) => {
    try {
      return await explain(await stateOf(chain), w, me, options);
    } catch {
      return [];
    }
  };
  try {
    if (!me) await connect();
    say("Approve it in your wallet…");
    await wallet.send(lattice(), chain, w);
  } catch (error) {
    if (error instanceof Said) return say(error.message, "bad"), false;
    const balance = await balanceOf(me, chain).catch(() => undefined);
    const why = /refused/i.test(error?.message ?? "") ? (await ask({ balance })).filter((x) => x.reason !== "done") : [];
    say(why.length > 0 ? `${why.map((x) => x.text).join(" ")} Nothing was taken from you.` : walletMessage(error), "bad");
    return false;
  }
  say("Sent. Confirming… this usually takes under a minute.", "wait");
  const deadline = Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const why = await ask();
    if (landed(w, why)) return say("Done.", "good"), true;
    const against = why.filter((x) => x.reason !== "done");
    if (against.length > 0) return say(`${against.map((x) => x.text).join(" ")} Nothing was taken from you.`, "bad"), false;
  }
  say("Sent, not confirmed yet. It may still land; look again in a minute.", "wait");
  return false;
}

/** Runs `send` with `form`'s controls disabled, and enables them again however it ends. */
async function submitting(form, send, after = () => setTimeout(rerender, 800)) {
  setBusy(form, true);
  try {
    if (await send()) after();
  } finally {
    setBusy(form, false);
  }
}
const setBusy = (form, busy) => form.querySelectorAll("button, input, textarea, select").forEach((el) => (el.disabled = busy));

// Drawing.

const $ = (selector, root = document) => root.querySelector(selector);
const main = () => $("main");
let renderId = 0;

function renderWho() {
  const who = $("#who");
  who.innerHTML = me
    ? `<a class="btn ghost small" href="#/me">My tickets</a><a class="chip mono" href="${artistHref(sellerKey(me))}" title="Your page · ${esc(me)}">${esc(short(me))}</a>`
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

const avatar = (label) => `<span class="avatar" aria-hidden="true">${esc(String(label || "?").slice(0, 1).toUpperCase())}</span>`;

/** A check mark when the artist's own site lists their address; nothing otherwise. */
const badge = (verdict) =>
  verdict?.verified ? `<span class="verified" title="${esc(verdict.site)} lists this artist's address">✓ ${esc(verdict.site)}</span>` : "";

function failure(error, what) {
  return `<div class="empty"><h2>Can't read ${esc(what)}</h2><p class="muted">${esc(error?.message ?? error)}</p>
    <p><button class="btn" type="button" data-act="retry">Try again</button> <button class="btn ghost" type="button" data-act="settings">Choose another node</button></p></div>`;
}

const where = (l) => [dateText(l.date), l.venue].filter(Boolean).map(esc).join(" · ");

// Home: what's on, then who sells.

async function showHome(id) {
  main().innerHTML = `<section class="hero"><h1>Tickets, straight from artists.</h1>
    <p class="muted">Artists sell from their own wallet. Your ticket is yours: keep it, give it away or sell it on.</p>
    <div class="acts"><a class="btn primary" href="#/sell">Sell on Fanfare</a>${me ? `<a class="btn" href="#/me">My tickets</a>` : ""}</div></section>
    <h2 class="section">Coming up</h2><div id="coming"><p class="muted">Reading…</p></div>
    <h2 class="section">Artists</h2><div class="grid" id="artists"></div>`;
  let all;
  try {
    all = await everyone();
  } catch (error) {
    if (id === renderId) $("#coming").outerHTML = failure(error, settings.home);
    return;
  }
  if (id !== renderId) return;
  const cards = new Map(await Promise.all(all.map(async ({ info }) => [info.key, await cardOf(info.artist)])));
  if (id !== renderId) return;
  const shows = byDate(all.flatMap(({ info, listings }) => listings.filter((l) => !l.closed).map((l) => ({ ...l, info }))), today()).upcoming;
  $("#coming").innerHTML = shows.length
    ? `<ul class="coming">${shows.slice(0, 20).map((l) => `<li><a class="card show-row" href="${artistHref(l.info.key)}/${encodeURIComponent(l.name)}">
        <span class="when"><b>${esc(dateText(l.date).split(" ").slice(1, 3).join(" "))}</b><span>${esc(dateText(l.date).split(" ")[0])}</span></span>
        <span><strong>${esc(nameOf(l.info, cards.get(l.info.key)))}</strong><span class="muted small">${esc(l.title)}${l.venue ? ` · ${esc(l.venue)}` : ""}</span></span>${imageTag(l.info.chain, l.media, "thumb")}</a></li>`).join("")}</ul>`
    : `<p class="muted">No shows on sale yet. <a href="#/sell">Put yours on sale.</a></p>`;
  // One card per artist: the Fanfare chain and their own coin's chain, together.
  const byArtist = new Map();
  for (const entry of all) byArtist.set(entry.info.artist, [...(byArtist.get(entry.info.artist) ?? []), entry]);
  const people = [...byArtist.values()].map((entries) => {
    const main = entries.reduce((a, b) => (b.listings.length > a.listings.length ? b : a));
    return { info: main.info, shows: entries.reduce((n, e) => n + e.listings.length, 0), coin: entries.find((e) => e.info.own)?.info.coin };
  });
  $("#artists").innerHTML = people.length
    ? people.map(({ info, shows: n, coin }) => {
        const label = nameOf(info, cards.get(info.key));
        return `<a class="card artist" href="${artistHref(info.key)}" data-artist="${esc(info.key)}">${avatar(label)}<span><strong>${esc(label)}</strong><span class="small muted">${plural(n, "show")}${coin ? ` · own coin, ${esc(coin)}` : ""}</span><span class="small badge-slot"></span></span></a>`;
      }).join("")
    : `<p class="muted">Nobody yet. <a href="#/sell">Be the first.</a></p>`;
  for (const { info } of people) {
    verdictOf(info.artist, cards.get(info.key)).then((verdict) => {
      const slot = $(`[data-artist="${CSS.escape(info.key)}"] .badge-slot`);
      if (slot && id === renderId) slot.innerHTML = badge(verdict);
    });
  }
}

// An artist's page.

let page; // what the artist page last read, for its forms
/** A listing whose "Buy" to open again once the page is read anew. */
let reopenBuy;

async function loadArtist(key) {
  const info = await sellerInfo(key);
  const state = await stateOf(info.chain);
  const { artist } = info;
  const [card, listings, balance, staff] = await Promise.all([
    cardOf(artist),
    artist ? read.listings(state, artist).then((all) => all.filter((l) => l.kind === "ticket")) : [],
    me ? balanceOf(me, info.chain) : undefined,
    artist ? read.staff(state, artist) : [],
  ]);
  const withTickets = await Promise.all(
    listings.map(async (listing) => {
      const tickets = await read.tickets(state, artist, listing.name);
      return { ...listing, tickets, ...summary(listing, tickets, await read.checkedIn(state, artist, listing.name)) };
    }),
  );
  const isArtist = me !== null && me === artist;
  return { ...info, state, card, listings: withTickets, balance, isArtist, staff, label: nameOf(info, card) };
}

async function showArtist(route, id) {
  main().innerHTML = `<p class="muted">Reading…</p>`;
  let p;
  try {
    p = await loadArtist(route.key);
  } catch (error) {
    if (id === renderId) main().innerHTML = failure(error, "this artist");
    return;
  }
  if (id !== renderId) return;
  page = p;
  const verdict = await verdictOf(p.artist, p.card);
  if (id !== renderId) return;
  document.title = `${p.label} · Fanfare`;
  const shows = byDate(p.listings, today());
  const upcoming = [...shows.upcoming, ...shows.undated];
  main().innerHTML = `
    <section class="artist-head">
      ${avatar(p.label)}
      <div><h1>${esc(p.label)}</h1>
        <p class="small">${badge(verdict)}${p.own ? `${verdict?.verified ? " · " : ""}<span class="muted">Prices in their own coin, ${esc(p.coin)}</span>` : ""}</p>
        ${p.card.description ? `<p>${esc(p.card.description)}</p>` : ""}
        ${p.card.links?.length ? `<ul class="links">${p.card.links.filter((l) => /^https?:\/\//i.test(l.url)).map((l) => `<li><a href="${esc(l.url)}" target="_blank" rel="noopener noreferrer nofollow">${esc(l.label || l.url)} ↗</a></li>`).join("")}</ul>` : ""}
      </div>
      <div class="head-acts">${p.isArtist || p.staff.includes(me) ? `<a class="btn" href="${doorHref(p.key)}">Door</a>` : ""}${p.isArtist ? `<button class="btn primary" type="button" data-act="new-listing">New show</button>` : ""}</div>
    </section>
    ${!p.fanfare ? `<p class="note warn">This chain runs its own rules, not Fanfare's. Fanfare can't vouch that its tickets can't be taken back.</p>` : ""}
    ${!p.artist ? `<p class="note warn">This chain's first block paid no one, so Fanfare can't tell whose it is.</p>` : ""}
    ${p.isArtist ? artistTools(p, verdict) : ""}
    ${upcoming.length ? `<h2 class="section">Shows</h2>${upcoming.map((l) => listingCard(p, l)).join("")}` : ""}
    ${shows.past.length ? `<details class="past"><summary>Past shows (${shows.past.length})</summary>${shows.past.map((l) => listingCard(p, l)).join("")}</details>` : ""}
    ${upcoming.length === 0 ? `<div class="empty"><p class="muted">No shows coming up.</p>${p.isArtist ? `<button class="btn primary" type="button" data-act="new-listing">Put a show on sale</button>` : ""}</div>` : ""}
    ${p.own ? coinBlock(p) : ""}`;
  if (route.listing) $(`#l-${CSS.escape(route.listing)}`)?.scrollIntoView({ block: "start" });
  const again = reopenBuy;
  reopenBuy = undefined;
  if (again) {
    const l = p.listings.find((x) => x.name === again);
    if (l?.next) buyForm({ dataset: { listing: l.name, ticket: l.next.id }, closest: () => $(`#l-${CSS.escape(l.name)}`) });
  }
}

/** The artist's own coin, for artists who launched one: what fans hold it for, and its risk said plainly. */
function coinBlock(p) {
  return `<section class="coin card"><div><h2>${esc(p.coin)}, ${esc(p.label)}'s coin</h2>
      <p class="small muted">Spend it on what ${esc(p.label)} sells here. It's for supporting them, not for making money: its price can fall to nothing.</p></div>
    <div class="coin-row"><div><span class="label">You have</span><strong class="big">${p.balance === undefined ? "—" : money(p.balance, p.coin)}</strong></div>
      <div class="coin-acts"><button class="btn" type="button" data-act="buy-coin">Get ${esc(p.coin)}</button>${p.isArtist || (p.balance ?? 0n) > 0n ? `<button class="btn ghost" type="button" data-act="sell-coin">Offer some</button>` : ""}</div></div>
    <div id="market" hidden></div></section>`;
}

function listingCard(p, l) {
  const mineHeld = me && !p.isArtist ? l.tickets.filter((t) => t.holder === me) : [];
  const resales = l.forSale.filter((t) => t.holder !== p.artist && t.holder !== me);
  const next = l.next && l.next.holder !== me && !(p.isArtist && l.next.holder === p.artist) ? l.next : undefined;
  const stock = l.total === 0 ? "" : l.left > 0 ? `${l.left} left` : "Sold out";
  const buy = next && !l.closed
    ? `<button class="btn primary" type="button" data-act="buy" data-listing="${esc(l.name)}" data-ticket="${esc(next.id)}">Buy ticket · ${money(next.price, p.coin)}</button>${next.holder !== p.artist ? ` <span class="small muted">resale${l.price ? `, originally ${money(l.price, p.coin)}` : ""}</span>` : ""}`
    : l.total > 0 && !p.isArtist ? `<span class="muted">${l.closed ? "Sales closed" : "Sold out"}</span>` : "";
  return `<article class="card listing${l.closed ? " closed" : ""}" id="l-${esc(l.name)}">
    ${imageTag(p.chain, l.media, "show-image")}
    <header><div><h3>${esc(l.title)}</h3>${where(l) ? `<p class="muted small">${where(l)}</p>` : ""}</div>
      <p class="small muted">${p.isArtist ? `Sold ${l.held} of ${plural(l.total, "ticket")}` : stock}</p></header>
    ${mineHeld.length ? `<p class="small">You have ${plural(mineHeld.length, "ticket")} · <a href="#/me">My tickets</a></p>` : ""}
    <div class="buy-row">${buy}</div>
    ${resales.some((t) => t !== next) ? `<details class="resales"><summary>${plural(resales.length, "resale ticket")}</summary><ul class="seats">${resales.map((t) => `<li><span>${l.used.has(t.id) ? `<span class="tag used">used</span>` : ""}</span><span class="price">${money(t.price, p.coin)}${l.price ? ` <span class="small muted">${markup(l.price, t.price)}</span>` : ""}</span><button class="btn small" type="button" data-act="buy" data-listing="${esc(l.name)}" data-ticket="${esc(t.id)}">Buy</button></li>`).join("")}</ul></details>` : ""}
    <div class="form-slot"></div>
  </article>`;
}

/** A resale price against the original: "+60%", "same as original", "−20%". */
function markup(original, price) {
  if (price === original) return "same as original";
  const pct = Number(((price - original) * 100n) / original);
  return `${pct > 0 ? "+" : "−"}${Math.abs(pct)}% on ${coins(original)}`;
}

/** The artist's own view: their link, their name, door staff, and how to show fans it's them. */
function artistTools(p, verdict) {
  const share = `${location.origin}${location.pathname}${artistHref(p.key)}`;
  return `<section class="card tools"><h2>Your page</h2>
    <div class="tool-row"><span>Send fans your page.</span><button class="btn small" type="button" data-act="copy" data-text="${esc(share)}">Copy link</button></div>
    ${p.card.name ? "" : `<div class="tool-row"><span>Fans see your address, not a name.</span><a class="btn small" href="${MONIKER_APP}" target="_blank" rel="noopener">Add your name and picture</a></div>`}
    <div class="tool-row"><span>Door staff: ${p.staff.length ? p.staff.map((s) => `<span class="mono">${esc(short(s))}</span>`).join(", ") : "only you"}</span><button class="btn small ghost" type="button" data-act="add-staff">Add staff</button></div>
    ${verdict?.verified ? "" : `<details class="verify"><summary>Show fans this is really you</summary><p class="small">Put your website on <a href="${MONIKER_APP}" target="_blank" rel="noopener">your Moniker profile</a>, then serve your address, <span class="mono">${esc(p.artist)}</span>, as a line of <span class="mono">https://&lt;your site&gt;/.well-known/lattice</span> with the header <span class="mono">Access-Control-Allow-Origin: *</span>. Fanfare then shows a check mark by your name.</p></details>`}
    ${p.own ? "" : `<p class="small muted">Want fans to be able to hold and mine a coin of yours? <a href="#/launch">Your own coin</a> is an optional next step.</p>`}
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

// Buying.

function buyForm(button) {
  const p = page;
  const l = p.listings.find((x) => x.name === button.dataset.listing);
  const t = l?.tickets.find((x) => x.id === button.dataset.ticket);
  if (!t) return;
  const card = button.closest(".listing");
  const fee = 1n;
  const used = l.used.has(t.id) ? `<p class="warn-text small">This ticket was already checked in at the door: it won't get anyone in again.</p>` : "";
  const short_ = p.balance !== undefined && p.balance < t.price + fee;
  openForm($(".form-slot", card), `<form class="inline sheet" data-act="confirm-buy" data-listing="${esc(l.name)}" data-ticket="${esc(t.id)}">
    ${t.holder !== p.artist ? `<p class="what muted small">Resold by a fan${l.price ? `, originally ${money(l.price, p.coin)}` : ""}</p>` : ""}
    <dl class="total"><dt>Price</dt><dd>${money(t.price, p.coin)}</dd><dt>Network fee</dt><dd>${money(fee, p.coin)}</dd><dt>Total</dt><dd><strong>${money(t.price + fee, p.coin)}</strong></dd></dl>
    ${used}
    ${short_ ? `<p class="warn-text small">You have ${money(p.balance, p.coin)}, ${money(t.price + fee - p.balance, p.coin)} short.${p.own ? ` <button class="linkish" type="button" data-act="buy-coin">Get ${esc(p.coin)}</button>` : ` <a href="#/me">Get ${FAN}</a>`}</p>` : ""}
    <div class="acts"><button class="btn primary" type="submit"${short_ ? " disabled" : ""}>Pay ${money(t.price + fee, p.coin)} in wallet</button><button class="btn ghost" type="button" data-act="close-form">Cancel</button></div>
    <p class="status" hidden></p><div class="after" hidden></div></form>`);
}

/** Whether the page still shows `p`: a form opened on it may write for it. */
const still = (p) => page === p;

async function confirmBuy(form) {
  const p = page;
  const say = sayer($(".status", form));
  const l = p.listings.find((x) => x.name === form.dataset.listing);
  const seen = l?.tickets.find((x) => x.id === form.dataset.ticket);
  if (!seen) return say("This one is gone; look again.", "bad");
  if (!me) await connect().catch((e) => say(e.message, "bad"));
  if (!me || !still(p)) return;
  if (seen.holder === me) return say("This one is already yours.", "bad");
  const w = write.buy(seen, me);
  await submitting(form, async () => {
    const ok = await perform(p.chain, w, say);
    const after = $(".after", form);
    after.hidden = false;
    after.innerHTML = ok
      ? `<p class="good-text">It's yours. <a href="#/me">See it in My tickets</a>, with your door pass.</p>`
      : l.next || l.tickets.some((t) => t.price !== undefined && t.id !== seen.id)
        ? `<button class="btn" type="button" data-act="buy-next" data-listing="${esc(l.name)}">Try the next ticket</button>`
        : "";
    return false;
  });
}

// Selling: a new show, for an artist on their page or on #/sell.

function listingForm(coin) {
  return `<form class="inline" data-act="create-listing">
    <label for="nl-title">Show</label><input id="nl-title" name="title" required placeholder="Berlin" maxlength="120">
    <div class="row"><span><label for="nl-date">Date</label><input id="nl-date" name="date" type="date"></span><span><label for="nl-venue">Venue</label><input id="nl-venue" name="venue" placeholder="Tresor, Berlin" maxlength="120"></span></div>
    <div class="row"><span><label for="nl-count">How many tickets</label><input id="nl-count" name="count" inputmode="numeric" value="100" required></span><span><label for="nl-price">Price, in ${esc(coin)}</label><input id="nl-price" name="price" inputmode="numeric" value="250" required></span></div>
    <div class="image-field"><label for="nl-image">Image <span class="muted">(optional)</span></label>
      ${settings.ownNode && settings.ownCookie
        ? `<input id="nl-image" type="file" accept="image/png,image/jpeg,image/gif,image/webp,image/avif"><input type="hidden" name="media"><img class="preview" hidden alt=""><p class="small muted image-note">Your node, ${esc(settings.ownNode)}, keeps it and fans' nodes can serve it.</p>`
        : `<p class="small muted">Images are kept by your own node. <button class="linkish" type="button" data-act="settings">Set your node</button> to add one.</p>`}</div>
    <p class="small muted">Fans see how many exist. Once sold, a ticket is the fan's: they can give it away or sell it on at any price, and you can't take it back.</p>
    <div class="acts"><button class="btn primary" type="submit">Put on sale</button></div>
    <p class="status" hidden></p><div class="after" hidden></div></form>`;
}

function newListingForm() {
  openForm($(".tools .form-slot"), `<h3>New show</h3>${listingForm(page.coin)}<div class="acts"><button class="btn ghost" type="button" data-act="close-form">Cancel</button></div>`);
}

async function createListing(form) {
  // The artist's own page, or #/sell: the connected wallet on the Fanfare chain.
  const p = page;
  if (!p?.isArtist) return;
  const say = sayer($(".status", form));
  const data = Object.fromEntries(new FormData(form));
  const count = Number(amountIn(data.count) ?? 0n);
  const price = amountIn(data.price);
  if (count < 1 || count > 500) return say("Between 1 and 500 at a time.", "bad");
  if (price === undefined) return say("The price is a whole number above zero.", "bad");
  const title = data.title.trim();
  let name = slug(title);
  const taken = new Set(p.listings.map((l) => l.name));
  for (let n = 2; taken.has(name); n++) name = `${slug(title)}-${n}`;
  if (!isItemName(name)) return say("Give it a title with letters or digits.", "bad");
  const record = {
    kind: "ticket",
    title,
    price: String(price),
    ...(data.venue?.trim() && { venue: data.venue.trim() }),
    ...(data.date && { date: data.date }),
    ...(data.media && { media: data.media }),
  };
  const writes = [...write.listing(p.artist, name, record), ...newIds(name, [], count).flatMap((id) => write.mint(p.artist, id, { price }))];
  const share = `${location.origin}${location.pathname}${artistHref(p.key)}`;
  await submitting(form, async () => perform(p.chain, { actions: await write.changes(p.state, writes) }, say), () => {
    const after = $(".after", form);
    after.hidden = false;
    after.innerHTML = `<p class="good-text">On sale. <a href="${artistHref(p.key)}/${encodeURIComponent(name)}">See it as fans do</a> · <button class="linkish" type="button" data-act="copy" data-text="${esc(share)}">Copy your link</button></p>`;
    // Read again, so the next listing is named against this one.
    loadArtist(p.key).then((fresh) => still(p) && (page = fresh), () => {});
  });
}

/** Keeps the chosen image on the artist's own node, and names it in the form by CID. */
async function keepImage(input) {
  const form = input.form;
  const note = $(".image-note", form);
  const preview = $(".preview", form);
  $("[name=media]", form).value = "";
  preview.hidden = true;
  const file = input.files?.[0];
  if (!file) return;
  if (!IMAGE_TYPES.test(file.type)) return (note.textContent = "Choose a PNG, JPEG, GIF, WebP or AVIF image.");
  if (file.size > IMAGE_MAX) return (note.textContent = "Choose an image under 2 MB.");
  note.textContent = "Keeping it on your node…";
  const button = $("button[type=submit]", form);
  button.disabled = true;
  try {
    const volume = mediaVolume(sdk, file.type, new Uint8Array(await file.arrayBuffer()));
    await operator(settings.ownNode, settings.ownCookie).pin(volume);
    $("[name=media]", form).value = volume.cid;
    preview.src = URL.createObjectURL(file);
    preview.hidden = false;
    note.textContent = "Kept by your node.";
  } catch (error) {
    note.textContent = `Your node didn't keep it: ${error.message}. Check the node and its cookie in Settings, and that it allows this site (rpcAllowedOrigins).`;
  } finally {
    button.disabled = false;
  }
}

async function showSell(id) {
  if (!me) {
    main().innerHTML = `<section class="hero"><h1>Sell on Fanfare</h1>
      <p class="muted">Put a show on sale in a minute. You need only your Lattice wallet: fans pay you directly, in ${FAN}, and Fanfare takes nothing.</p>
      <div class="acts"><button class="btn primary" type="button" data-act="connect">Connect wallet</button></div></section>`;
    return;
  }
  main().innerHTML = `<p class="muted">Reading…</p>`;
  let p;
  try {
    p = await loadArtist(sellerKey(me));
  } catch (error) {
    if (id === renderId) main().innerHTML = failure(error, settings.home);
    return;
  }
  if (id !== renderId) return;
  page = p;
  main().innerHTML = `<h1>Sell on Fanfare</h1>
    <p class="muted">Fans pay you directly in ${FAN}. ${p.listings.length ? `You have ${plural(p.listings.length, "show")} on <a href="${artistHref(p.key)}">your page</a>.` : ""}</p>
    ${p.balance === 0n ? `<p class="note">Each write costs a network fee of 1 ${FAN}, and you have none yet. <button class="linkish" type="button" data-act="get-fan">Get ${FAN}</button></p><div id="fan-market" hidden></div>` : ""}
    ${p.card.name ? "" : `<p class="note">Fans will see your address until you <a href="${MONIKER_APP}" target="_blank" rel="noopener">add your name and picture on Moniker</a>, the profile every Lattice app reads.</p>`}
    <section class="card">${listingForm(FAN)}</section>
    <p class="small muted">Want a coin of your own, that fans can hold and mine? It's optional, and best once you have fans. <a href="#/launch">Your own coin</a></p>`;
}

function staffForm() {
  openForm($(".tools .form-slot"), `<form class="inline" data-act="save-staff"><label for="staff">Their Lattice address</label><input id="staff" name="staff" class="mono" required placeholder="bafyrei…"><p class="small muted">Staff can check tickets in at your door. They pay a fee of 1 for each check-in.</p><div class="acts"><button class="btn primary" type="submit">Add</button><button class="btn ghost" type="button" data-act="close-form">Cancel</button></div><p class="status" hidden></p></form>`);
}

async function saveStaff(form) {
  const p = page;
  const say = sayer($(".status", form));
  const address = new FormData(form).get("staff").trim();
  if (!profiles.isAddress(address)) return say("That isn't a Lattice address.", "bad");
  await submitting(form, async () => perform(p.chain, { actions: await write.changes(p.state, write.staff(p.artist, address)) }, say));
}

// A chain's coin for its parent's: the artist's coin for FAN, or FAN for the
// coin of the chain Fanfare sits under.

/** The coin of the chain above `chain`, as a label. */
const parentCoin = (chain) => (chain.length > HOME().length ? FAN : `${chain.at(-2) ?? "parent"} coin`);

async function showMarket(selling, box = $("#market"), { chain = page.chain, coin = page.coin, have = page.balance } = {}) {
  box.hidden = false;
  const theirs = parentCoin(chain);
  if (selling) {
    box.innerHTML = `<form class="inline" data-act="sell-coin-confirm" data-chain="${esc(chain.join("/"))}"><p class="small muted">Offer ${esc(coin)} for ${esc(theirs)}. Anyone can take the whole offer; your wallet locks the coin until then.</p>
      <div class="row"><span><label for="sell-coin">${esc(coin)} to offer</label><input id="sell-coin" name="coin" inputmode="numeric" required></span><span><label for="sell-price">${esc(theirs)} you want</label><input id="sell-price" name="price" inputmode="numeric" required></span></div>
      <div class="acts"><button class="btn primary" type="submit">Offer in wallet</button></div><p class="status" hidden></p></form>`;
    return;
  }
  box.innerHTML = `<p class="small muted">Reading offers…</p>`;
  let offers;
  try {
    offers = await market.offers(nodeURL(), chain);
  } catch (error) {
    box.innerHTML = `<p class="small warn-text">${esc(error.message)}</p>`;
    return;
  }
  box.innerHTML = offers.length === 0
    ? `<p class="small muted">Nobody is offering ${esc(coin)} right now. You can also earn it by mining ${esc(chain.join("/"))}${coin === FAN ? ", or ask an artist or a friend to send you some" : ""}.</p>`
    : `<form class="inline" data-act="buy-coin-confirm" data-chain="${esc(chain.join("/"))}" data-coin="${esc(coin)}"><table class="offers"><thead><tr><th>${esc(coin)}</th><th>for ${esc(theirs)}</th><th>each</th></tr></thead><tbody>${offers.slice(0, 8).map((o) => `<tr><td>${coins(o.coin)}</td><td>${coins(o.price)}</td><td class="muted">${(Number(o.price) / Number(o.coin)).toPrecision(3)}</td></tr>`).join("")}</tbody></table>
      ${offers.length > 8 ? `<p class="small muted">and ${plural(offers.length - 8, "more offer")}.</p>` : ""}
      <label for="want">How much ${esc(coin)}?</label><input id="want" name="want" inputmode="numeric" required>
      ${have !== undefined ? `<p class="small muted">You have ${money(have, coin)}.</p>` : ""}
      <div class="acts"><button class="btn primary" type="submit">Find offers</button></div><p class="status" hidden></p><div class="acts" id="coin-go" hidden></div></form>`;
  box.offers = offers;
}

/** Offers are taken whole, so the page says what that comes to and asks again before the wallet does. */
function buyCoin(form) {
  const chain = form.dataset.chain.split("/");
  const coin = form.dataset.coin;
  const say = sayer($(".status", form));
  const go = $("#coin-go", form);
  go.hidden = true;
  const want = amountIn(new FormData(form).get("want"));
  if (want === undefined) return say("A whole number above zero.", "bad");
  const picked = market.pick(form.parentElement.offers, want);
  if (!picked) return say(`Offers hold less than ${coins(want)} ${coin} in all.`, "bad");
  say(`Offers are taken whole: ${plural(picked.offers.length, "offer")} come to ${coins(picked.coin)} ${coin} for ${coins(picked.price)} ${parentCoin(chain)}.`);
  go.hidden = false;
  go.innerHTML = `<a class="btn primary" href="${esc(market.buyRequest(chain, picked.offers))}">Get ${coins(picked.coin)} ${esc(coin)} in wallet</a>`;
}

function sellCoin(form) {
  const say = sayer($(".status", form));
  const data = new FormData(form);
  const [coin, price] = [amountIn(data.get("coin")), amountIn(data.get("price"))];
  if (coin === undefined || price === undefined) return say("Whole numbers above zero.", "bad");
  say("Your wallet takes it from here.", "wait");
  location.href = market.sellRequest(form.dataset.chain.split("/"), coin, price);
}

// My tickets: every ticket the connected account holds, by show date.

let mineCache = [];

async function showMine(id) {
  if (!me) {
    main().innerHTML = `<div class="empty"><h1>My tickets</h1><p class="muted">Connect your wallet to see what you hold.</p><button class="btn primary" type="button" data-act="connect">Connect wallet</button></div>`;
    return;
  }
  main().innerHTML = `<h1>My tickets</h1><section class="card wallet-row" id="fan-coin"></section><div id="mine"><p class="muted">Reading…</p></div>`;
  balanceOf(me, HOME()).then((have) => {
    const box = $("#fan-coin");
    if (box && id === renderId) box.innerHTML = `<div><span class="label">You have</span><strong class="big">${money(have, FAN)}</strong></div><button class="btn" type="button" data-act="get-fan">Get ${FAN}</button><div id="fan-market" hidden></div>`;
  }).catch(() => {});
  const items = [];
  const homeState = await stateOf(HOME()).catch(() => undefined);
  const places = [];
  if (homeState) {
    for (const t of await read.heldAll(homeState, me)) places.push({ key: sellerKey(t.artist), state: homeState, ticket: t });
  }
  for (const name of await directory().catch(() => [])) {
    try {
      const info = await sellerInfo(name);
      if (!info.artist) continue;
      const state = await stateOf(info.chain);
      for (const t of await read.held(state, info.artist, me)) places.push({ key: name, state, ticket: t });
    } catch {}
  }
  for (const { key, state, ticket } of places) {
    try {
      const info = await sellerInfo(key);
      const listing = (await read.listings(state, info.artist)).find((l) => l.kind === "ticket" && door.inListing(l.name, ticket.id));
      if (!listing) continue;
      const card = await cardOf(info.artist);
      const used = (await read.checkins(state, info.artist, ticket.id)).length > 0;
      items.push({ info, ticket, listing, label: nameOf(info, card), used });
    } catch {}
  }
  if (id !== renderId) return;
  mineCache = items;
  if (items.length === 0) {
    $("#mine").innerHTML = `<p class="muted">Nothing yet. <a href="#/">See what's coming up.</a></p>`;
    return;
  }
  const shows = byDate(items.map((x) => ({ ...x, date: x.listing.date })), today());
  const upcoming = [...shows.upcoming, ...shows.undated];
  $("#mine").innerHTML = [
    upcoming.length ? `<h2 class="section">Upcoming shows</h2><ul class="held">${upcoming.map(heldRow).join("")}</ul>` : "",
    shows.past.length ? `<details class="past"><summary>Past shows (${shows.past.length})</summary><ul class="held">${shows.past.map(heldRow).join("")}</ul></details>` : "",
  ].join("");
}

function heldRow(x) {
  const { info, ticket, listing } = x;
  return `<li data-key="${esc(info.key)}" data-ticket="${esc(ticket.id)}">
    <div class="held-head">${imageTag(info.chain, listing.media, "thumb")}<div><strong>${esc(listing.title)}</strong> <span class="muted">· <a href="${artistHref(info.key)}">${esc(x.label)}</a></span>
      ${where(listing) ? `<br><span class="small muted">${where(listing)}</span>` : ""}
      ${ticket.price !== undefined ? `<br><span class="tag">On sale at ${money(ticket.price, info.coin)}</span>` : ""}</div></div>
    ${x.used ? `<p class="small muted">Used at the door</p>` : ""}
    <div class="acts">${!x.used ? `<button class="btn small primary" type="button" data-act="pass">Door pass</button>` : ""}<button class="btn small" type="button" data-act="resell">${ticket.price !== undefined ? "Change price" : "Sell"}</button><button class="btn small ghost" type="button" data-act="give">Give</button></div><div class="form-slot"></div></li>`;
}

const heldEntry = (el) => {
  const row = el.closest("li[data-ticket]");
  const entry = mineCache.find((x) => x.info.key === row.dataset.key && x.ticket.id === row.dataset.ticket);
  return { row, entry, ticket: entry?.ticket };
};

/** A pass, signed once and kept in this browser, so it opens again without the wallet. */
async function passFor(entry) {
  const id = `pass|${entry.info.chain.join("/")}|${entry.info.artist}|${entry.ticket.id}|${me}`;
  const kept = store.get(id, undefined);
  if (typeof kept === "string") return kept;
  const code = await door.pass(lattice(), ORIGIN, entry.info.chain.join("/"), entry.info.artist, entry.ticket.id);
  store.set(id, code);
  return code;
}

const qrSvg = (text, cell = 4) => {
  const qr = qrcode(0, "L");
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: cell, margin: 4, scalable: true });
};
const passLink = (code) => `${location.origin}${location.pathname}#/pass/${encodeURIComponent(code)}`;

async function showPass(button) {
  const { row, entry } = heldEntry(button);
  const slot = openForm($(".form-slot", row), `<div class="pass"><p class="small muted">Approve in your wallet…</p></div>`);
  try {
    const code = await passFor(entry);
    const svg = qrSvg(code);
    const file = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    slot.innerHTML = `<div class="pass">${svg}
      <p class="small">Show this at the door. It works until the ticket is checked in, or until you sell or give the ticket away. Anyone with a copy can use it, so keep it to yourself.</p>
      <details class="to-phone"><summary>Keep it on your phone</summary><p class="small muted">Scan this with your phone's camera to open the pass there, then add it to your home screen or take a screenshot.</p>${qrSvg(passLink(code), 3)}</details>
      <div class="acts"><a class="btn small" href="${file}" download="${esc(`${entry.listing.name}-pass.svg`)}">Save image</a><button class="btn small ghost" type="button" data-act="close-form">Done</button></div></div>`;
  } catch (error) {
    slot.innerHTML = `<p class="status bad">${esc(walletMessage(error))}</p>`;
  }
}

/** #/pass/<code>: a pass on its own, full screen, for a phone. Needs no wallet and no node. */
function showPassPage(route) {
  const scanned = door.readPass(route.code);
  if (!scanned) {
    main().innerHTML = `<div class="empty"><h1>Not a pass</h1><p class="muted">This link doesn't hold a Fanfare door pass.</p></div>`;
    return;
  }
  document.title = "Door pass · Fanfare";
  main().innerHTML = `<div class="pass full">${qrSvg(route.code, 6)}<p><strong>Door pass</strong><br><span class="small muted">Ticket ${esc(scanned.id)}</span></p>
    <p class="small muted">Turn your screen brightness up at the door. This pass works until the ticket is checked in or changes hands.</p></div>`;
}

function resellForm(button) {
  const { row, entry, ticket } = heldEntry(button);
  const original = entry.listing.price;
  openForm($(".form-slot", row), `<form class="inline" data-act="resell-confirm"><label for="rp">Price, in ${esc(entry.info.coin)}</label><input id="rp" name="price" inputmode="numeric" value="${ticket.price ?? ""}">
    <p class="small muted">${original ? `It cost ${money(original, entry.info.coin)} new; buyers see that next to your price. ` : ""}Anyone can buy it at this price, at once, and your door pass stops working when they do. Leave it empty to take it off sale.</p>
    <div class="acts"><button class="btn primary" type="submit">Save in wallet</button><button class="btn ghost" type="button" data-act="close-form">Cancel</button></div><p class="status" hidden></p></form>`);
}

async function resell(form) {
  const { entry, ticket } = heldEntry(form);
  const say = sayer($(".status", form));
  const text = new FormData(form).get("price").trim();
  const price = text === "" ? undefined : amountIn(text);
  if (text !== "" && price === undefined) return say("A whole number above zero, or empty.", "bad");
  await submitting(form, () => perform(entry.info.chain, { actions: [write.price(ticket, price)] }, say));
}

function giveForm(button) {
  const { row } = heldEntry(button);
  openForm($(".form-slot", row), `<form class="inline" data-act="give-confirm"><label for="to">Give to</label><input id="to" name="to" required placeholder="@handle or bafyrei…" autocomplete="off">
    <div class="acts"><button class="btn primary" type="submit">Find them</button><button class="btn ghost" type="button" data-act="close-form">Cancel</button></div><p class="status" hidden></p></form>`);
}

/** Finds who `to` names (a Moniker @handle or an address), shows them, then asks once more before the wallet does. */
async function give(form) {
  const { entry, ticket } = heldEntry(form);
  const say = sayer($(".status", form));
  const to = String(new FormData(form).get("to")).trim();
  let address = to;
  if (to.startsWith("@")) {
    const held = await profiles.resolve(await (profileState ??= stateOf(PROFILE())), to.slice(1).toLowerCase()).catch(() => undefined);
    if (!held) return say(`Nobody holds ${to} on Moniker.`, "bad");
    address = held.holder;
  } else if (!profiles.isAddress(to)) return say("Type their @handle or their Lattice address.", "bad");
  if (address === me) return say("That's you.", "bad");
  if (form.dataset.to !== address) {
    const card = await cardOf(address);
    form.dataset.to = address;
    $("button[type=submit]", form).textContent = `Give to ${card.name ?? short(address)} in wallet`;
    return say(`${card.name ?? "This address"}${card.handle ? ` (@${card.handle})` : ""}, ${short(address)}. Once it lands it's theirs, and you can't take it back.`);
  }
  await submitting(form, () => perform(entry.info.chain, { actions: [write.transfer(ticket, address)] }, say));
}

// The door: staff pick the show, then scan. A good pass is checked in at
// once, and the page says "Let them in" only when the check-in has landed.

let scanning = null;
function stopScan() {
  scanning?.stop();
  scanning = null;
}

/** The Fanfare sites whose passes this door accepts: this one and any in Settings. */
const acceptedOrigins = () => [
  ORIGIN,
  ...settings.origins.split(/[\s,]+/).filter(Boolean).flatMap((text) => {
    try {
      return [new URL(text).origin];
    } catch {
      return [];
    }
  }),
];

// { info, listing, seen: ids this door let in, sent: ids it sent a check-in for, busy }
let doorAt;

async function showDoor(route, id) {
  let info;
  let listings;
  try {
    info = await sellerInfo(route.key);
    listings = info.artist ? (await read.listings(await stateOf(info.chain), info.artist)).filter((l) => l.kind === "ticket") : [];
  } catch (error) {
    if (id === renderId) main().innerHTML = failure(error, "this artist");
    return;
  }
  if (id !== renderId) return;
  const listing = route.listing && listings.find((l) => l.name === route.listing);
  if (!listing) {
    const split = byDate(listings, today());
    main().innerHTML = `<a class="back" href="${artistHref(route.key)}">← Back</a><h1>Door</h1><p class="muted">Which show?</p>
      ${listings.length ? `<ul class="shows">${[...split.upcoming, ...split.undated, ...split.past].map((l) => `<li><a class="card artist" href="${doorHref(route.key, l.name)}"><span><strong>${esc(l.title)}</strong><span class="muted small">${where(l)}</span></span></a></li>`).join("")}</ul>` : `<p class="muted">No shows yet.</p>`}`;
    return;
  }
  const same = doorAt?.info.key === info.key && doorAt.listing.name === listing.name;
  doorAt = { info, listing, seen: same ? doorAt.seen : new Set(), sent: same ? doorAt.sent : new Set(), busy: false };
  main().innerHTML = `<a class="back" href="${doorHref(route.key)}">← Shows</a><h1>Door · ${esc(listing.title)}</h1>
    <p class="muted">${where(listing)}${me ? "" : " · Connect the wallet you check people in with."}</p>
    <div class="door card"><video id="camera" playsinline muted hidden></video>
      <div class="acts"><button class="btn primary" type="button" data-act="camera">Use camera</button></div>
      <form data-act="check-pass" class="inline"><label for="code">Or paste a pass</label><textarea id="code" name="code" rows="3" class="mono"></textarea><button class="btn" type="submit">Check</button></form>
      <div id="verdict" aria-live="assertive"></div></div>`;
}

async function startCamera(button) {
  if (!("BarcodeDetector" in window)) return showVerdict("bad", "Stop", "This browser can't read QR codes from the camera. Paste the pass instead.");
  const id = renderId;
  // Held before any wait, so leaving the page stops it even mid-prompt.
  let stopped = false;
  let stream;
  scanning = { stop: () => ((stopped = true), stream?.getTracks().forEach((t) => t.stop())) };
  const video = $("#camera");
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
    if (stopped || id !== renderId) return stream.getTracks().forEach((t) => t.stop());
    video.srcObject = stream;
    video.hidden = false;
    await video.play();
    button.hidden = true;
    const detector = new window.BarcodeDetector({ formats: ["qr_code"] });
    let last = "";
    while (!stopped && id === renderId) {
      const [code] = doorAt.busy ? [] : await detector.detect(video).catch(() => []);
      if (code && code.rawValue !== last) {
        last = code.rawValue;
        // One pass going wrong doesn't stop the camera.
        await checkPass(code.rawValue).catch((error) => alertLine(error.message));
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  } catch (error) {
    if (!stopped) showVerdict("bad", "Stop", `The camera didn't start: ${error.message}`);
  }
}

/** Shows a verdict at the door that is still `at`; returns its status line, or a no-op. */
function showVerdict(kind, head, text, at = doorAt) {
  const box = $("#verdict");
  if (!box || at !== doorAt) return () => {};
  box.innerHTML = `<div class="verdict ${kind}"><strong>${esc(head)}</strong><p>${esc(text)}</p><p class="status" hidden></p></div>`;
  return sayer($(".status", box));
}

async function checkPass(code) {
  const at = doorAt;
  if (!at) return;
  if (at.busy) return alertLine("Still recording the last check-in…");
  // A pass link opened on a phone and scanned at the door carries the pass in its hash.
  const text = String(code).trim();
  const scanned = door.readPass(text.includes("#/pass/") ? parseRoute(text.slice(text.indexOf("#"))).code : text);
  if (!scanned) return showVerdict("bad", "Stop", "That isn't a Fanfare pass.");
  if (scanned.artist !== at.info.artist) return showVerdict("bad", "Stop", "This pass is for another artist's ticket.");
  if (at.seen.has(scanned.id)) return showVerdict("bad", "Stop", `This ticket was already let in at this door.`);
  at.busy = true;
  try {
    const state = await stateOf(at.info.chain);
    const ticket = await read.ticket(state, at.info.artist, scanned.id);
    const checkins = ticket ? await read.checkins(state, at.info.artist, ticket.id) : [];
    const v = await door.check(sdk, acceptedOrigins(), at.info.chain.join("/"), scanned, at.listing, ticket, checkins);
    const label = ticket && `ticket ${ticket.id.slice(at.listing.name.length + 1) || ticket.id}, held by ${short(ticket.holder)}`;
    // A check-in this door sent that landed after it stopped waiting: the fan is in.
    if (v.reason === "used" && at.sent.has(ticket.id) && checkins.includes(me)) {
      at.seen.add(ticket.id);
      return showVerdict("good", "Let them in", `${at.listing.title} · ${label}. This door checked them in.`, at);
    }
    if (!v.ok) return showVerdict("bad", "Stop", v.text, at);
    if (!me) await connect().catch(() => {});
    if (!me) return showVerdict("bad", "Wait", "Connect the wallet you check people in with.", at);
    if (me !== at.info.artist && !(await read.staff(state, at.info.artist)).includes(me))
      return showVerdict("bad", "Wait", "This wallet isn't on the artist's door staff, so its check-in wouldn't count.", at);
    const say = showVerdict("wait", "Checking in…", `${at.listing.title} · ${label}. The pass is good; recording the check-in.`, at);
    // The ticket id is fixed here: a scan meanwhile can't change what is checked in.
    const w = { actions: await write.changes(state, write.checkin(me, at.info.artist, ticket.id)) };
    at.sent.add(ticket.id);
    if (await perform(at.info.chain, w, (t, kind) => doorAt === at && say(t, kind))) {
      at.seen.add(ticket.id);
      showVerdict("good", "Let them in", `${at.listing.title} · ${label}. Checked in.`, at);
    }
  } finally {
    at.busy = false;
  }
}

// Your own coin: an optional step for an artist with fans.

function showLaunch() {
  main().innerHTML = `<a class="back" href="#/sell">← Sell on Fanfare</a><h1>Your own coin</h1>
    <section class="card consider"><p>Most artists don't need this: you can sell everything on Fanfare in ${FAN}. Your own coin is for artists whose fans want to hold something of theirs.</p>
      <ul>
        <li>It's a chain of your own under Fanfare. Fans can mine it, buy it from others, and spend it on what you price in it.</li>
        <li>What you already sell in ${FAN} stays as it is. Nothing moves over.</li>
        <li>Fans need your coin to buy what you price in it, which is one more step for them.</li>
        <li>It's permanent: once your chain exists it can't be taken back, and fans keep what they hold.</li>
        <li>Your name is attached to its price. Give fans reasons to hold it, like presales or members-only shows, and never call it an investment.</li>
      </ul></section>
    <form class="card launch" data-act="launch-command">
      <label for="ln">Your coin's name</label><input id="ln" name="name" required autocomplete="off" placeholder="band" pattern="[A-Za-z0-9][A-Za-z0-9_-]*">
      <p class="small muted">Fans find your coin by this name. It's first come, first served. Your chain will be <span class="mono" id="ln-path">${esc(settings.home)}/…</span></p>
      <p class="defaults" id="ln-defaults">You get <strong>${coins(launch.premineAmount(launch.defaults))}</strong> of your coin at launch. Miners earn ${coins(launch.defaults.initialReward)} a block after that, halving every ${coins(launch.defaults.halvingInterval)} blocks. <button class="linkish" type="button" data-act="change-defaults">Change</button></p>
      <div id="ln-change" hidden><div class="row"><span><label for="ln-premine">Blocks of rewards to you at launch</label><input id="ln-premine" name="premine" inputmode="numeric" value="${launch.defaults.premine}"></span><span><label for="ln-reward">Reward per block</label><input id="ln-reward" name="initialReward" inputmode="numeric" value="${launch.defaults.initialReward}"></span><span><label for="ln-halving">Halving every</label><input id="ln-halving" name="halvingInterval" inputmode="numeric" value="${launch.defaults.halvingInterval}"></span></div></div>
      <div class="acts"><button class="btn primary" type="submit">Get the launch steps</button></div>
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
    <li>If your node doesn't host ${esc(settings.home)} yet, add it to <span class="mono">hostedChains</span> in your <span class="mono">lattice.json</span> and run <span class="mono">lattice up</span>.</li>
    <li>Run, on your node:<pre class="mono">${esc(`lattice ${launch.createArguments({ name, specFile: file, moduleFile: "fanfare_policy.wasm", artist: me, home: HOME() }).join(" ")}`)}</pre></li>
    <li>Your node mines your chain's first block with its next one. Then <a href="${artistHref(name)}">open your coin's page</a> and put a show on sale.</li></ol>`;
}

// Settings.

function openSettings() {
  const dialog = $("#settings");
  dialog.querySelector("[name=node]").value = settings.node;
  dialog.querySelector("[name=home]").value = settings.home;
  dialog.querySelector("[name=profile]").value = settings.profile;
  dialog.querySelector("[name=origins]").value = settings.origins;
  dialog.querySelector("[name=ownNode]").value = settings.ownNode;
  dialog.querySelector("[name=ownCookie]").value = settings.ownCookie;
  dialog.showModal();
}

function saveSettings(form) {
  const data = Object.fromEntries(new FormData(form));
  Object.assign(settings, {
    node: data.node.trim(),
    home: data.home.trim() || DEFAULTS.home,
    profile: data.profile.trim() || DEFAULTS.profile,
    origins: data.origins.trim(),
    ownNode: data.ownNode.trim().replace(/\/+$/, ""),
    ownCookie: data.ownCookie.trim(),
  });
  store.set("settings", settings);
  sellers.clear();
  homePending = undefined;
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
  document.body.classList.toggle("bare", route.view === "pass");
  for (const a of document.querySelectorAll("header nav a")) a.setAttribute("aria-current", a.getAttribute("href") === `#/${route.view === "home" ? "" : route.view}` ? "page" : "false");
  if (route.view === "pass") return showPassPage(route);
  if (!settings.node) {
    main().innerHTML = `<div class="empty"><h1>Choose a node</h1><p class="muted">Fanfare reads every record from a Lattice node and checks it here. Point it at yours, or any node that hosts ${esc(settings.home)}.</p><button class="btn primary" type="button" data-act="settings">Choose a node</button></div>`;
    return;
  }
  const views = { home: showHome, artist: showArtist, me: showMine, door: showDoor, launch: showLaunch, sell: showSell };
  Promise.resolve(views[route.view](["home", "me", "sell"].includes(route.view) ? id : route, id)).catch((error) => {
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
  "buy-next": (el) => {
    reopenBuy = el.dataset.listing;
    rerender();
  },
  "new-listing": newListingForm,
  "add-staff": staffForm,
  "buy-coin": () => showMarket(false),
  "sell-coin": () => showMarket(true),
  "get-fan": async () => showMarket(false, $("#fan-market"), { chain: HOME(), coin: FAN, have: await balanceOf(me, HOME()).catch(() => undefined) }),
  copy: (el) => navigator.clipboard?.writeText(el.dataset.text).then(() => alertLine("Copied."), () => alertLine(el.dataset.text)),
  pass: showPass,
  resell: resellForm,
  give: giveForm,
  camera: startCamera,
  "change-defaults": () => {
    $("#ln-change").hidden = false;
    $("#ln-defaults").hidden = true;
  },
};
const submits = {
  "confirm-buy": confirmBuy,
  "create-listing": createListing,
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
  // A changed recipient is found again before anything is given.
  if (event.target.id === "to") delete event.target.form.dataset.to;
});
document.addEventListener("change", (event) => {
  if (event.target.id === "nl-image") keepImage(event.target).catch((error) => alertLine(error.message));
});
window.addEventListener("hashchange", rerender);
// Images are read once the HTML that names them is on the page.
new MutationObserver(() => showImages(main())).observe(main(), { childList: true, subtree: true });

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
