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
 * `#/door/<artist>/<listing>`, `#/launch`.
 */
export function parseRoute(hash) {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean).map((part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  });
  if (parts[0] === "a" && parts[1]) return { view: "artist", name: parts[1], ...(parts.length > 2 && { listing: parts.slice(2).join("/") }) };
  if (parts[0] === "door" && parts[1]) return { view: "door", name: parts[1], ...(parts.length > 2 && { listing: parts.slice(2).join("/") }) };
  if (parts[0] === "me") return { view: "me" };
  if (parts[0] === "launch") return { view: "launch" };
  return { view: "home" };
}

export const artistHref = (name) => `#/a/${encodeURIComponent(name)}`;

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
