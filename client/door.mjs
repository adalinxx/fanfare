// The door check. The fan's page shows a pass: the chain, the artist and the
// ticket, signed by the fan's Lattice wallet (`signMessage`) with the
// holder's key, as a QR code. A pass has no time limit: the fan can save it
// and open it on any device. Staff at one show's door scan it; the scanner
// reads the ticket's holder from state now, checks the signature against
// that holder and that the ticket is for this show, then writes the check-in
// (write.mjs `checkin`) and lets them in once it lands.
//
// So a pass stops working when its ticket is checked in, sold or given away:
// the new holder's key didn't sign it. A copy of a pass works for whoever
// reaches the door first, as a printed ticket does. Two doors scanning the
// same pass within one block can both admit it: both check-ins land.
//
// The wallet signs "lattice-message:" + the asking page's origin + "\n" +
// the text. A transaction's signed bytes start with another prefix, so a pass
// can't be passed off as a transaction. The pass names the site it was made
// on, and a door accepts only the Fanfare sites it lists, so a site that got
// a holder to sign a pass can't use it.

const PREFIX = "fanfare-pass:";

/** The text a pass signs: ticket `id` of `artist` on `chain` (a path, joined by "/"). */
export const passText = (chain, artist, id) => `fanfare-door\nchain:${chain}\nartist:${artist}\nticket:${id}`;

/** The bytes a wallet signs for `text` asked by a page at `origin`. */
export const signedBytes = (origin, text) => new TextEncoder().encode(`lattice-message:${origin}\n${text}`);

/**
 * A pass for ticket `id` of `artist` on `chain`, signed by the fan's wallet
 * (`window.lattice`) on a page at `origin`: the text to put in a QR code.
 * The wallet binds the signature to the page's origin, so the pass names it
 * and the door checks it against the Fanfare sites it accepts.
 */
export async function pass(lattice, origin, chain, artist, id) {
  const { publicKey, signature } = await lattice.signMessage({ text: passText(chain, artist, id) });
  return PREFIX + JSON.stringify({ o: origin, c: chain, a: artist, i: id, k: publicKey, s: signature });
}

/** A scanned pass as `{ origin, chain, artist, id, proof }`, or undefined if it isn't one. */
export function readPass(code) {
  if (typeof code !== "string" || !code.startsWith(PREFIX)) return undefined;
  try {
    const { o, c, a, i, k, s } = JSON.parse(code.slice(PREFIX.length));
    if (![o, c, a, i, k, s].every((field) => typeof field === "string" && field !== "")) return undefined;
    return { origin: o, chain: c, artist: a, id: i, proof: { publicKey: k, signature: s } };
  } catch {
    return undefined;
  }
}

/** Whether ticket `id` belongs to listing `name`: the one-off `name`, or `name/…`. */
export const inListing = (name, id) => id === name || id.startsWith(`${name}/`);

/**
 * Whether `proof` signs `text`, asked by Fanfare at `origin`, with the key
 * of `ticket`'s holder.
 */
export async function verify(sdk, origin, text, proof, ticket) {
  try {
    if (sdk.addressFromMultikey(proof.publicKey) !== ticket.holder) return false;
    const key = await crypto.subtle.importKey("raw", sdk.decodeEd25519Multikey(proof.publicKey), "Ed25519", false, ["verify"]);
    return await crypto.subtle.verify("Ed25519", key, sdk.hexToBytes(proof.signature), signedBytes(origin, text));
  } catch {
    return false;
  }
}

/**
 * The scanner's verdict on a pass (from `readPass`) at the door of
 * `listing` (read.mjs `listing`) on `chain`, for `ticket` as read now, with
 * `checkins` (read.mjs `checkins`) for it: `{ ok: true }`, or `{ ok: false,
 * reason, text }`. `origins` are the Fanfare sites whose passes this door
 * accepts.
 */
export async function check(sdk, origins, chain, scanned, listing, ticket, checkins) {
  if (!origins.includes(scanned.origin))
    return { ok: false, reason: "site", text: `This pass was made on ${scanned.origin}, which this door doesn't accept.` };
  if (scanned.chain !== chain || !ticket || ticket.artist !== scanned.artist || ticket.id !== scanned.id)
    return { ok: false, reason: "no-ticket", text: "There is no such ticket." };
  if (listing?.artist !== ticket.artist || listing.kind !== "ticket" || !inListing(listing.name, ticket.id))
    return { ok: false, reason: "other-show", text: `This ticket isn't for ${listing?.title ?? "this show"}.` };
  if (!(await verify(sdk, scanned.origin, passText(scanned.chain, scanned.artist, scanned.id), scanned.proof, ticket)))
    return { ok: false, reason: "not-holder", text: "This pass isn't from the ticket's holder. It may have been sold or given away since." };
  if (checkins.length > 0) return { ok: false, reason: "used", text: "This ticket was already checked in." };
  return { ok: true };
}
