// Shipping addresses, readable only by the artist. A fan buying merch writes
// `user/<fan>/ship/<artist>/<id>`, encrypted to the artist's X25519 key.
//
// Fanfare keeps no key, so the artist's encryption key comes from their
// wallet: the wallet signs a fixed text (`signMessage`), and Ed25519
// signatures are deterministic, so the same account on the same site always
// gets the same key back, and nobody without the account can. The public half
// sits on the artist's profile on Moniker (Nexus/moniker) as
// `app.fanfare.x25519`, an app field: another app may derive its own key the
// same way, and neither overwrites the other's.
//
// Box: an ephemeral X25519 key agrees a secret with the artist's key, HKDF
// stretches it into an AES-GCM key, and the record is JSON
// `{ v: 1, epk, iv, ct }`, each field base64url.

export const KEY_FIELD = "app.fanfare.x25519";
const KEY_TEXT = "fanfare-encryption-key\nv1\nSigning this unlocks shipping addresses sent to you on Fanfare.";
const INFO = new TextEncoder().encode("fanfare-ship-v1");
// A raw 32-byte X25519 private key, as PKCS#8.
const PKCS8 = [0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20];

const b64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
const unb64 = (text) => Uint8Array.from(atob(text.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));
const hex = (text) => Uint8Array.from(text.match(/../g), (pair) => parseInt(pair, 16));

/**
 * The artist's key pair from their wallet (`window.lattice`):
 * `{ privateKey, publicKey }`, the public key base64url for the profile field.
 */
export async function artistKey(lattice) {
  const { signature } = await lattice.signMessage({ text: KEY_TEXT });
  const seed = new Uint8Array(await crypto.subtle.digest("SHA-256", hex(signature)));
  const privateKey = await crypto.subtle.importKey("pkcs8", Uint8Array.from([...PKCS8, ...seed]), "X25519", true, ["deriveBits"]);
  // WebCrypto has no direct "public from private"; its JWK carries both.
  const { x } = await crypto.subtle.exportKey("jwk", privateKey);
  return { privateKey, publicKey: x };
}

async function boxKey(privateKey, publicKey, salt) {
  const shared = await crypto.subtle.deriveBits({ name: "X25519", public: publicKey }, privateKey, 256);
  const hkdf = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt, info: INFO }, hkdf, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

/** `address` (any JSON value) sealed to the artist's public key, as the record's value. */
export async function seal(artistPublicKey, address) {
  const theirs = await crypto.subtle.importKey("raw", unb64(artistPublicKey), "X25519", false, []);
  const mine = await crypto.subtle.generateKey("X25519", true, ["deriveBits"]);
  const epk = new Uint8Array(await crypto.subtle.exportKey("raw", mine.publicKey));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await boxKey(mine.privateKey, theirs, epk);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(address)));
  return JSON.stringify({ v: 1, epk: b64(epk), iv: b64(iv), ct: b64(ct) });
}

/** The address in a record, opened with the artist's key, or undefined if it isn't theirs or doesn't parse. */
export async function open(artistPrivateKey, value) {
  try {
    const { v, epk, iv, ct } = JSON.parse(value);
    if (v !== 1) return undefined;
    const theirs = await crypto.subtle.importKey("raw", unb64(epk), "X25519", false, []);
    const key = await boxKey(artistPrivateKey, theirs, unb64(epk));
    return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, key, unb64(ct))));
  } catch {
    return undefined;
  }
}
