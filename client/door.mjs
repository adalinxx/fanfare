// The door check. The scanner reads the ticket's holder from state, shows a
// fresh challenge, and the fan's Lattice wallet signs it (`signMessage`) with
// the holder's key. A screenshot of someone else's ticket can't answer a
// challenge it has not seen. Staff then write the check-in (write.mjs
// `checkin`).
//
// The wallet signs "lattice-message:" + the asking page's origin + "\n" +
// the text. A transaction's signed bytes start with another prefix, so a
// challenge can't be passed off as a transaction, and with the origin inside,
// an answer given to another site does not verify here.

/** A one-time challenge for ticket `id` of `artist`. */
export function challenge(artist, id) {
  const nonce = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `fanfare-door\nartist:${artist}\nticket:${id}\nnonce:${nonce}`;
}

/** The bytes a wallet signs for `text` asked by a page at `origin`. */
export const signedBytes = (origin, text) => new TextEncoder().encode(`lattice-message:${origin}\n${text}`);

/** The fan's answer from their wallet (`window.lattice`): `{ publicKey, signature }`, both hex. */
export const prove = (lattice, text) => lattice.signMessage({ text });

/**
 * Whether `proof` answers `text`, asked by Fanfare at `origin`, with the key
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
