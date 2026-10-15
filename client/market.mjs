// Artist coin for Fanfare coin, through Lattice's own child↔parent swap: a
// seller locks artist coin on the artist chain (a deposit naming the Fanfare
// coin it wants), a buyer pays the seller on the parent chain (a receipt) and
// claims the coin (a withdrawal). Open deposits are the offers.
//
// The wallet settles: Fanfare reads offers for display and hands the wallet a
// `lattice://order` request. The wallet proves every offer it is asked to take
// against the chain, picks the account, nonces and fees, and asks the person,
// so nothing here is trusted for money.

const UINT64_MAX = 2n ** 64n - 1n;
const PAGE = 100;
const PAGES = 100;
/** How long an order request stays valid in the wallet. */
export const ORDER_LIFETIME_MS = 15 * 60_000;

const amount = (value) => {
  if (typeof value !== "string" && !Number.isSafeInteger(value)) return undefined;
  const text = String(value);
  if (!/^(0|[1-9][0-9]*)$/.test(text)) return undefined;
  const parsed = BigInt(text);
  return parsed > 0n && parsed <= UINT64_MAX ? parsed : undefined;
};
const nonce = (value) => {
  const text = typeof value === "number" || typeof value === "string" ? String(value) : "";
  return /^(0|[1-9][0-9]*)$/.test(text) && BigInt(text) <= UINT64_MAX ? BigInt(text) : undefined;
};

/** One deposit row as a node lists it, or undefined if it does not parse. */
export function offer(row) {
  if (typeof row !== "object" || row === null || typeof row.demander !== "string" || row.demander === "") return undefined;
  const coin = amount(row.amountDeposited);
  const price = amount(row.amountDemanded);
  const depositNonce = nonce(row.nonce);
  if (coin === undefined || price === undefined || depositNonce === undefined) return undefined;
  if (row.key !== `${row.demander}/${price}/${depositNonce}`) return undefined;
  return { seller: row.demander, coin, price, depositNonce };
}

/** Cheapest Fanfare coin per artist coin first; ties by the larger offer. */
export const cheapestFirst = (a, b) => {
  const left = a.price * b.coin;
  const right = b.price * a.coin;
  if (left !== right) return left < right ? -1 : 1;
  return a.coin === b.coin ? 0 : a.coin > b.coin ? -1 : 1;
};

/**
 * The open offers for `chainPath`'s coin from one node, cheapest first. Rows
 * that do not parse are skipped. Display only: the wallet proves an offer
 * before it pays for it.
 */
export async function offers(nodeURL, chainPath, fetchImpl = fetch) {
  const found = [];
  let after;
  for (let page = 0; page < PAGES; page++) {
    const url = new URL("api/deposits", nodeURL.endsWith("/") ? nodeURL : `${nodeURL}/`);
    url.searchParams.set("chainPath", chainPath.join("/"));
    url.searchParams.set("limit", String(PAGE));
    if (after !== undefined) url.searchParams.set("after", after);
    const response = await fetchImpl(url);
    if (!response.ok) throw new Error(`${url.host} answered ${response.status} for offers`);
    const body = await response.json();
    for (const row of Array.isArray(body?.deposits) ? body.deposits : []) {
      const parsed = offer(row);
      if (parsed) found.push(parsed);
    }
    if (typeof body?.next !== "string" || body.next === after) break;
    after = body.next;
  }
  return found.sort(cheapestFirst);
}

/**
 * The offers to take, cheapest first, until they hold at least `want` artist
 * coin. Offers are taken whole, so the total may exceed `want`; undefined if
 * all of them together hold less.
 */
export function pick(sorted, want) {
  const taken = [];
  let coin = 0n;
  let price = 0n;
  for (const each of sorted) {
    if (coin >= want) break;
    taken.push(each);
    coin += each.coin;
    price += each.price;
  }
  return coin >= want ? { offers: taken, coin, price } : undefined;
}

const base64url = (text) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(text)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");

function order(chainPath, fields, now) {
  if (chainPath.length < 2 || chainPath[0] !== "Nexus") throw new Error("An artist coin lives on a child chain");
  const intent = {
    version: 1,
    parentChain: chainPath.slice(0, -1),
    childChain: [...chainPath],
    asset: "LAT",
    expiresAt: new Date(now + ORDER_LIFETIME_MS).toISOString(),
    ...fields,
  };
  return `lattice://order?v=1&intent=${base64url(JSON.stringify(intent))}`;
}

/** Ask the wallet to offer `coin` artist coin for `price` Fanfare coin. */
export function sellRequest(chainPath, coin, price, now = Date.now()) {
  const [offered, wanted] = [amount(String(coin)), amount(String(price))];
  if (offered === undefined || wanted === undefined) throw new Error("Amounts must be whole and above zero");
  return order(chainPath, { side: "sell_child", orderType: "limit", amountDeposited: String(offered), amountDemanded: String(wanted) }, now);
}

/** Ask the wallet to take these offers, each whole. */
export function buyRequest(chainPath, taken, now = Date.now()) {
  if (taken.length === 0) throw new Error("Choose at least one offer");
  const deposits = taken.map(({ seller, coin, price, depositNonce }) => ({
    demander: seller,
    amountDemanded: String(price),
    amountDeposited: String(coin),
    depositNonce: String(depositNonce),
  }));
  return order(chainPath, { side: "buy_child", orderType: "take", deposits }, now);
}
