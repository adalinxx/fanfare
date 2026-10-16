// The parts of the page that are pure: no network, no DOM, no storage. The
// page and its tests share them.

export const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);

export const short = (address) => (address ? `${address.slice(0, 8)}…${address.slice(-4)}` : "");

/** A coin amount with thousands separators. */
export const coins = (amount) => BigInt(amount).toLocaleString("en-US");

/** `n` and the word, singular for one. */
export const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

/**
 * `#/`, `#/a/<artist>`, `#/a/<artist>/<listing>`, `#/me`, `#/door/<artist>`,
 * `#/door/<artist>/<listing>`, `#/pass/<code>`, `#/sell`, `#/launch`. An
 * artist is a chain's name, or `@<address>` for one selling on the Fanfare
 * chain itself; `@` can't start a chain name.
 */
export function parseRoute(hash) {
  const raw = hash.replace(/^#\/?/, "");
  if (raw.startsWith("pass/")) return { view: "pass", code: decode(raw.slice("pass/".length)) };
  const parts = raw.split("/").filter(Boolean).map(decode);
  if (parts[0] === "a" && parts[1]) return { view: "artist", key: parts[1], ...(parts.length > 2 && { listing: parts.slice(2).join("/") }) };
  if (parts[0] === "door" && parts[1]) return { view: "door", key: parts[1], ...(parts.length > 2 && { listing: parts.slice(2).join("/") }) };
  if (parts[0] === "me") return { view: "me" };
  if (parts[0] === "sell") return { view: "sell" };
  if (parts[0] === "launch") return { view: "launch" };
  return { view: "home" };
}

function decode(part) {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

/** The artist key for `address` selling on the Fanfare chain. */
export const sellerKey = (address) => `@${address}`;
/** The address in an `@<address>` key, or undefined for a chain's name. */
export const sellerAddress = (key) => (typeof key === "string" && key.startsWith("@") ? key.slice(1) : undefined);

export const artistHref = (key) => `#/a/${encodeURIComponent(key)}`;
export const doorHref = (key, listing) => `#/door/${encodeURIComponent(key)}${listing ? `/${encodeURIComponent(listing)}` : ""}`;

/** An artist name as a chain directory takes it: one path segment. */
export const isArtistName = (name) => typeof name === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name);

/**
 * A listing name or ticket id an artist types: segments of letters, digits,
 * `-` and `_`, joined by `/`.
 */
export const isItemName = (name) => typeof name === "string" && /^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*$/.test(name);

/** A listing name from its title: lowercase words joined by `-`. */
export const slug = (title) =>
  String(title).toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "listing";

/** What a listing's tickets are called. */
export const unitOf = (kind) => (kind === "qa" ? ["question slot", "question slots"] : kind === "merch" ? ["item", "items"] : ["ticket", "tickets"]);

/**
 * The ids of `count` new tickets for listing `name`, numbered after any it
 * already has: `name/1`, `name/2`, ...
 */
export function newIds(name, existing, count) {
  let next = 1;
  const taken = new Set(existing);
  const ids = [];
  while (ids.length < count) {
    const id = `${name}/${next++}`;
    if (!taken.has(id)) ids.push(id);
  }
  return ids;
}

/**
 * A listing's tickets as the page shows them: how many exist, how many fans
 * hold, and the ones for sale, cheapest first (the artist's and resales).
 * `used` are ids already used up (checked in, or a slot already answered):
 * they stay listed, marked, but don't count as the cheapest.
 */
export function summary(listing, tickets, used = new Set()) {
  const forSale = tickets.filter((t) => t.price !== undefined).sort((a, b) => (a.price < b.price ? -1 : a.price > b.price ? 1 : a.id < b.id ? -1 : 1));
  return {
    total: tickets.length,
    held: tickets.filter((t) => t.holder !== listing.artist).length,
    forSale,
    cheapest: forSale.find((t) => !used.has(t.id))?.price,
    // What one "Buy" takes: the cheapest ticket still good for something.
    next: forSale.find((t) => !used.has(t.id)),
    // The artist's own tickets still on sale.
    left: forSale.filter((t) => t.holder === listing.artist).length,
    used,
  };
}

/** A ticket's short label inside its listing: `A1` for `berlin/A1`, the listing's title for a one-off. */
export const seatOf = (listingName, id) => (id.startsWith(`${listingName}/`) ? id.slice(listingName.length + 1) : id);

/** The wallet's word for an error, said plainly. */
export function walletMessage(error) {
  const text = String(error?.message ?? error ?? "");
  if (/declin|reject|denied|cancel/i.test(text)) return "You declined in your wallet. Nothing was sent.";
  if (/not connected/i.test(text)) return "Connect your wallet first.";
  return text || "The wallet did not answer.";
}

/** A whole, positive amount typed into a field, or undefined. */
export function amountIn(text) {
  const trimmed = String(text ?? "").replaceAll(",", "").trim();
  if (!/^[0-9]+$/.test(trimmed)) return undefined;
  const value = BigInt(trimmed);
  return value > 0n && value < 2n ** 64n ? value : undefined;
}

/** Today as `YYYY-MM-DD` in the viewer's time zone, the form a listing's date takes. */
export const today = (now = new Date()) =>
  `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

/**
 * Listings split for showing: `upcoming` (dated today or later, soonest
 * first), `undated`, and `past` (latest first).
 */
export function byDate(listings, day) {
  const dated = listings.filter((l) => /^\d{4}-\d{2}-\d{2}$/.test(l.date ?? ""));
  return {
    upcoming: dated.filter((l) => l.date >= day).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)),
    undated: listings.filter((l) => !dated.includes(l)),
    past: dated.filter((l) => l.date < day).sort((a, b) => (a.date > b.date ? -1 : a.date < b.date ? 1 : 0)),
  };
}

/** A listing's date said plainly: `Sat 14 Nov 2026`. */
export function dateText(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? "")) return "";
  const [y, m, d] = date.split("-").map(Number);
  const day = new Date(y, m - 1, d);
  return `${"Sun Mon Tue Wed Thu Fri Sat".split(" ")[day.getDay()]} ${d} ${"Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ")[m - 1]} ${y}`;
}

const DAY = 24 * 60 * 60 * 1000;
/** The answer window a Q&A listing promises when it doesn't say: 7 days. */
export const ANSWER_WITHIN = 7;

/**
 * Where a question (read.mjs `questions`) stands: "answered", "overdue" once
 * `days` have passed since it was asked, or "waiting". A question with no
 * time is never overdue.
 */
export function questionStatus(q, days = ANSWER_WITHIN, now = Date.now()) {
  if (q.answer !== undefined) return "answered";
  return q.at !== undefined && now - q.at > days * DAY ? "overdue" : "waiting";
}

/**
 * An artist's record on paid questions: of those answered or overdue,
 * how many were answered. `{ answered, due }`.
 */
export function answerRecord(questions, days = ANSWER_WITHIN, now = Date.now()) {
  const statuses = questions.map((q) => questionStatus(q, days, now));
  const answered = statuses.filter((s) => s === "answered").length;
  return { answered, due: answered + statuses.filter((s) => s === "overdue").length };
}

/** How long ago `at` (Unix ms) was, roughly: "today", "3 days ago". */
export function ago(at, now = Date.now()) {
  const days = Math.floor((now - at) / DAY);
  return days <= 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`;
}
