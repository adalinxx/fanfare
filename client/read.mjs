// Reads Fanfare's records from a state view `{ get(key), list(prefix) }` (see
// state.mjs). Records are written by anyone, so every value is parsed as
// untrusted: a record that does not parse is skipped, never fatal.
//
// Tickets are trusted further only on a chain that runs the Fanfare policy
// (`runsFanfare`): there, every ticket was minted by its artist and changed
// only by its holder or by a buyer who paid the holder's price. An artist may
// launch with a different policy; the client then labels the chain custom.

/** The CID of the Fanfare policy module built from `policy/`. */
export const FANFARE_POLICY = "bafyreicpgzwln3czmak34v7na4loiy6czqrlztnsud3e547qrpcpgppt7y";

/**
 * Whether a chain spec (see state.mjs `chainSpec`) runs the Fanfare policy.
 * Every policy in a spec must accept a transaction, so further policies
 * may refuse more but never let through what Fanfare's refuses.
 */
export const runsFanfare = (spec) =>
  Array.isArray(spec?.wasmPolicies) &&
  spec.wasmPolicies.some(
    (policy) =>
      policy?.moduleCID === FANFARE_POLICY &&
      policy.scope === "transaction" &&
      policy.entrypoint === "lattice_validate_transaction",
  );

const parse = (value) => {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
};
const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
async function collect(entries) {
  const found = [];
  for await (const entry of entries) found.push(entry);
  return found;
}

/** Where ticket `id` of `artist` lives. */
export const ticketKey = (artist, id) => `own/${artist}/${id}`;

/**
 * The holder and price in a ticket value, as the policy reads them:
 * `<holder>` or `<holder>@<price>`, the price a canonical decimal.
 */
export function holding(value) {
  if (typeof value !== "string") return undefined;
  const at = value.indexOf("@");
  const holder = at < 0 ? value : value.slice(0, at);
  if (holder === "") return undefined;
  if (at < 0) return { holder };
  const digits = value.slice(at + 1);
  if (!/^(0|[1-9][0-9]*)$/.test(digits) || BigInt(digits) >= 2n ** 64n) return undefined;
  return { holder, price: BigInt(digits) };
}

const asTicket = (artist, id, value) => {
  const held = holding(value);
  return held && { artist, id, value, ...held };
};

/** `{ artist, id, value, holder, price? }` for ticket `id`, or undefined. */
export const ticket = async (state, artist, id) => asTicket(artist, id, await state.get(ticketKey(artist, id)));

/** Every ticket of `artist` whose id starts with `prefix`, in id order. */
async function ticketsUnder(state, artist, prefix) {
  const found = [];
  for await (const [key, value] of state.list(ticketKey(artist, prefix))) {
    const ticket = asTicket(artist, key.slice(ticketKey(artist, "").length), value);
    if (ticket) found.push(ticket);
  }
  return found;
}

/** The tickets of listing `name`: the one named `name`, and every `name/…`. */
export async function tickets(state, artist, name) {
  const [one, many] = await Promise.all([ticket(state, artist, name), ticketsUnder(state, artist, `${name}/`)]);
  return [...(one ? [one] : []), ...many];
}

/** Every ticket of `artist` that `fan` holds. One scan of the artist's tickets. */
export async function held(state, artist, fan) {
  return (await ticketsUnder(state, artist, "")).filter((ticket) => ticket.holder === fan);
}

// A listing's name is one path segment. Its tickets are `<name>` and
// `<name>/…`, so a name with a "/" in it would sit inside another listing's
// tickets; such a listing isn't one Fanfare shows.
const asListing = (artist, name, value) => {
  if (name === "" || name.includes("/")) return undefined;
  const record = parse(value);
  if (!isObject(record) || typeof record.title !== "string") return undefined;
  const text = (field) => (typeof record[field] === "string" ? { [field]: record[field] } : {});
  return {
    artist,
    name,
    kind: typeof record.kind === "string" ? record.kind : "ticket",
    title: record.title,
    ...text("venue"),
    ...text("date"),
    ...text("media"),
    closed: record.closed === true,
  };
};

/** Listing `name` of `artist`, or undefined. */
export const listing = async (state, artist, name) =>
  asListing(artist, name, await state.get(`item/${artist}/${name}`));

/** Every listing of `artist`, in name order. */
export async function listings(state, artist) {
  const prefix = `item/${artist}/`;
  return (await collect(state.list(prefix)))
    .map(([key, value]) => asListing(artist, key.slice(prefix.length), value))
    .filter(Boolean);
}

/** The door staff `artist` trusts. */
export async function staff(state, artist) {
  const prefix = `user/${artist}/staff/`;
  return (await collect(state.list(prefix))).map(([key]) => key.slice(prefix.length)).filter((s) => !s.includes("/"));
}

/**
 * Who checked ticket `id` in: the artist, or staff the artist lists. Anyone
 * can write a check-in under their own key; only these count.
 */
export async function checkins(state, artist, id) {
  const prefix = `index/checkin/${artist}/${id}/`;
  const trusted = new Set([artist, ...(await staff(state, artist))]);
  return (await collect(state.list(prefix)))
    .map(([key]) => key.slice(prefix.length))
    .filter((s) => !s.includes("/") && trusted.has(s));
}

/**
 * The questions on a Q&A listing: for each slot whose holder asked one,
 * `{ ticket, text, answer? }`. A question counts only from the slot's
 * current holder, so a slot sold on carries its new holder's question. An
 * answer names the question it answers (write.mjs `answer`), so it counts
 * only while the slot still asks that question.
 */
export async function questions(state, artist, name) {
  const slots = await tickets(state, artist, name);
  const asked = await Promise.all(
    slots.map(async (slot) => {
      const [text, answered] = await Promise.all([
        state.get(`user/${slot.holder}/question/${artist}/${slot.id}`),
        state.get(`user/${artist}/answer/${slot.id}`),
      ]);
      if (text === undefined) return undefined;
      const record = parse(answered);
      const answer = isObject(record) && record.question === text && typeof record.answer === "string" ? record.answer : undefined;
      return { ticket: slot, text, ...(answer !== undefined && { answer }) };
    }),
  );
  return asked.filter(Boolean);
}

/**
 * The tickets of listing `name` checked in by the artist or their staff, as
 * a set of ids: one read of the listing's check-ins, not one per ticket.
 */
export async function checkedIn(state, artist, name) {
  const trusted = new Set([artist, ...(await staff(state, artist))]);
  const prefix = `index/checkin/${artist}/`;
  const found = new Set();
  // `<prefix><name>/…` holds the one-off ticket `<name>` and every `<name>/…`.
  for await (const [key] of state.list(`${prefix}${name}/`)) {
    const rest = key.slice(prefix.length);
    const cut = rest.lastIndexOf("/");
    if (trusted.has(rest.slice(cut + 1))) found.add(rest.slice(0, cut));
  }
  return found;
}

/**
 * The shipping records for merch listing `name`: for each item whose holder
 * left one, `{ ticket, sealed }`, opened by the artist with ship.mjs `open`.
 * Like a question, a record counts only from the item's current holder.
 */
export async function shipments(state, artist, name) {
  const items = await tickets(state, artist, name);
  const found = await Promise.all(
    items.map(async (item) => {
      const sealed = await state.get(`user/${item.holder}/ship/${artist}/${item.id}`);
      return sealed === undefined ? undefined : { ticket: item, sealed };
    }),
  );
  return found.filter(Boolean);
}
