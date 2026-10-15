// The door check. The fan's page shows a pass: the ticket and the time,
// signed by the fan's Lattice wallet (`signMessage`) with the holder's key,
// as a QR code. Staff scan it; the scanner reads the ticket's holder from
// state, checks the signature and the time, and writes the check-in
// (write.mjs `checkin`). A pass lives two minutes, and a ticket already
// checked in is turned away, so a screenshot passed around gets one person
// in at most, and only within those minutes.
//
// The wallet signs "lattice-message:" + the asking page's origin + "\n" +
// the text. A transaction's signed bytes start with another prefix, so a pass
// can't be passed off as a transaction, and with the origin inside, a pass
// signed for another site does not verify here.

/** How long a pass is good for, either side of the scanner's clock. */
export const PASS_LIFETIME_MS = 2 * 60_000;
const PREFIX = "fanfare-pass:";

/** The text a pass signs: ticket `id` of `artist` at `time` (Unix seconds). */
export const passText = (artist, id, time) => `fanfare-door\nartist:${artist}\nticket:${id}\ntime:${time}`;

/** The bytes a wallet signs for `text` asked by a page at `origin`. */
export const signedBytes = (origin, text) => new TextEncoder().encode(`lattice-message:${origin}\n${text}`);

/** A pass for ticket `id` of `artist`, signed by the fan's wallet (`window.lattice`): the text to put in a QR code. */
export async function pass(lattice, artist, id, now = Date.now()) {
  const time = String(Math.floor(now / 1000));
  const { publicKey, signature } = await lattice.signMessage({ text: passText(artist, id, time) });
  return PREFIX + JSON.stringify({ a: artist, i: id, t: time, k: publicKey, s: signature });
}

/** A scanned pass as `{ artist, id, time, proof }`, or undefined if it isn't one. */
export function readPass(code) {
  if (typeof code !== "string" || !code.startsWith(PREFIX)) return undefined;
  try {
    const { a, i, t, k, s } = JSON.parse(code.slice(PREFIX.length));
    if (![a, i, t, k, s].every((field) => typeof field === "string" && field !== "") || !/^[0-9]+$/.test(t)) return undefined;
    return { artist: a, id: i, time: t, proof: { publicKey: k, signature: s } };
  } catch {
    return undefined;
  }
}

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
 * The scanner's verdict on a pass (from `readPass`) for `ticket` as read
 * now, with `checkins` (read.mjs `checkins`) for it: `{ ok: true }`, or
 * `{ ok: false, reason, text }`.
 */
export async function check(sdk, origin, scanned, ticket, checkins, now = Date.now()) {
  if (!ticket || ticket.artist !== scanned.artist || ticket.id !== scanned.id)
    return { ok: false, reason: "no-ticket", text: "There is no such ticket." };
  if (Math.abs(now - Number(scanned.time) * 1000) > PASS_LIFETIME_MS)
    return { ok: false, reason: "expired", text: "This pass has expired. Ask for a fresh one." };
  if (!(await verify(sdk, origin, passText(scanned.artist, scanned.id, scanned.time), scanned.proof, ticket)))
    return { ok: false, reason: "not-holder", text: "This pass isn't from the ticket's holder." };
  if (checkins.length > 0) return { ok: false, reason: "used", text: "This ticket was already checked in." };
  return { ok: true };
}
