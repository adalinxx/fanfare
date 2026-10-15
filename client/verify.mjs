// Names are first come, so `Nexus/fanfare/radiohead` may be anyone's. The
// client shows an artist as verified only when the chain, the artist's
// profile and the artist's own site all point at one another:
//
//   chain    → artist   the account its genesis paid (state.mjs premineRecipient)
//   artist   → site     the `url` on the artist's card on Nexus/profile
//   site     → artist   https://<site>/.well-known/lattice lists the address
//
// The last link is the one a squatter can't forge. The site serves the file
// as plain text, one address per line, readable from any page
// (`Access-Control-Allow-Origin: *`).

export const WELL_KNOWN = "/.well-known/lattice";

/** The https origin of a card's `url`, or undefined. */
export function site(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.username === "" && parsed.password === "" ? parsed.origin : undefined;
  } catch {
    return undefined;
  }
}

/** Whether the site at `origin` lists `address`. Redirects don't count. */
export async function linksBack(origin, address, fetchImpl = fetch) {
  try {
    const response = await fetchImpl(new URL(WELL_KNOWN, origin), { redirect: "error", cache: "no-store" });
    if (!response.ok) return false;
    return (await response.text()).split(/\r?\n/).some((line) => line.trim() === address);
  } catch {
    return false;
  }
}

/**
 * Whether `artist`, with profile `card` (lattice-profile `getProfile`), is
 * verified: `{ verified: true, site: <host> }`, or `{ verified: false }` with
 * the site it names, if any, so the page can show it unconfirmed.
 */
export async function verify(artist, card, fetchImpl = fetch) {
  const origin = artist === undefined ? undefined : site(card?.url);
  if (origin === undefined) return { verified: false };
  const host = new URL(origin).host;
  return (await linksBack(origin, artist, fetchImpl)) ? { verified: true, site: host } : { verified: false, site: host };
}
