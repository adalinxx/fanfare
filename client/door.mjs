// The door check. The scanner reads the ticket's holder from state, shows a
// fresh challenge, and the fan's wallet signs it with the holder's key. A
// screenshot of someone else's ticket can't answer a challenge it has not
// seen. Staff then write the check-in (write.mjs `checkin`).
//
// The signature uses the wallet's one signing domain, which transactions
// share. A transaction's signed text starts `domain:`; a challenge starts
// `fanfare-door`, so neither can be passed off as the other.

/** A one-time challenge for ticket `id` of `artist`. */
export function challenge(artist, id) {
  const nonce = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `fanfare-door\nartist:${artist}\nticket:${id}\nnonce:${nonce}`;
}

/** The fan's answer: `{ publicKey, signature }`, both hex. */
export const prove = (sdk, text, privateKey) => ({
  publicKey: sdk.bytesToHex(sdk.publicKeyFromPrivate(privateKey)),
  signature: sdk.signPreimage(text, privateKey),
});

/** Whether `proof` answers `text` with the key of `ticket`'s holder. */
export function verify(sdk, text, proof, ticket) {
  try {
    const publicKey = sdk.hexToBytes(proof.publicKey);
    return sdk.addressFromPublicKey(publicKey) === ticket.holder && sdk.verifyPreimage(text, proof.signature, publicKey);
  } catch {
    return false;
  }
}
