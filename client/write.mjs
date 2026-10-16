// Builds the transactions that write records. A record change is a
// general-state action `{ key, oldValue?, newValue? }`: consensus applies it
// only when `oldValue` is what the key holds now, so a change is always made
// against a state the writer has read.
import { ticketKey } from "./read.mjs";

/**
 * The actions for a list of `[key, value]` writes against `state` (a view,
 * see state.mjs). A value of undefined deletes the key.
 */
export async function changes(state, writes) {
  const actions = await Promise.all(
    writes.map(async ([key, newValue]) => {
      const oldValue = await state.get(key);
      return {
        key,
        ...(oldValue !== undefined && { oldValue }),
        ...(newValue !== undefined && { newValue }),
      };
    }),
  );
  // Deleting a key that is not there changes nothing.
  return actions.filter((action) => "oldValue" in action || "newValue" in action);
}

/**
 * A transaction body carrying `actions`, signed for by `owner`, who pays the
 * fee and each of `payments` (`{ to, amount }`, as `buy` returns them).
 */
export function transaction({ owner, actions, payments = [], fee, nonce, chainPath }) {
  const credits = new Map();
  for (const { to, amount } of payments) credits.set(to, (credits.get(to) ?? 0n) + amount);
  const debit = fee + [...credits.values()].reduce((sum, amount) => sum + amount, 0n);
  return {
    accountActions: [
      ...(debit > 0n ? [{ owner, delta: -debit }] : []),
      ...[...credits].map(([to, amount]) => ({ owner: to, delta: amount })),
    ],
    actions,
    depositActions: [],
    receiptActions: [],
    withdrawalActions: [],
    signers: [owner],
    nonce,
    chainPath: [...chainPath],
  };
}

// The record conventions in the README. Each returns the `[key, value]`
// writes for one act, for `changes`; a value of undefined deletes the key.

const json = (value) => (value === undefined ? undefined : JSON.stringify(value));

/** A ticket's value: its holder, and its price when it is for sale. */
export function holding(holder, price) {
  if (price === undefined) return holder;
  if (typeof price !== "bigint" || price < 0n || price >= 2n ** 64n) throw new Error(`bad price: ${price}`);
  return `${holder}@${price}`;
}

// Artist.

/**
 * A listing `{ kind: "ticket", title, venue?, date?, price?, media?, closed? }` named by one
 * path segment. It can be edited and closed, never deleted.
 */
export const listing = (artist, name, value) => [[`item/${artist}/${name}`, json(value)]];

/**
 * A new ticket `<name>/<seat>` (or just `<name>` for a one-off), held by the
 * artist and for sale at `price`, or given to `to` as a comp. Minting over a
 * ticket that is already held changes it only if the artist still holds it.
 */
export const mint = (artist, id, { to = artist, price } = {}) => [
  [ticketKey(artist, id), holding(to, price)],
];

/** The artist trusts `staff` to check tickets in, or stops with `trusted` false. */
export const staff = (artist, s, trusted = true) => [[`user/${artist}/staff/${s}`, trusted ? "1" : undefined]];

// Door.

/** `s` (the artist or their staff) marks ticket `id` used. */
export const checkin = (s, artist, id) => [[`index/checkin/${artist}/${id}/${s}`, "1"]];

// Tickets as read (see read.mjs `ticket`). Each change names the value the
// writer saw as the old one, so if the ticket changed since, consensus
// refuses it: nobody pays a price they did not see.

/** `{ actions, payments }` for `buyer` taking `ticket` at its price. */
export function buy(ticket, buyer) {
  if (ticket.price === undefined) throw new Error(`${ticket.id} is not for sale`);
  if (ticket.holder === buyer) throw new Error(`${ticket.id} is already ${buyer}'s`);
  return {
    actions: [{ key: ticketKey(ticket.artist, ticket.id), oldValue: ticket.value, newValue: buyer }],
    payments: [{ to: ticket.holder, amount: ticket.price }],
  };
}

/** The holder's change of `ticket` to `holder`, for sale at `price` or not. */
export const hold = (ticket, holder, price) => ({
  key: ticketKey(ticket.artist, ticket.id),
  oldValue: ticket.value,
  newValue: holding(holder, price),
});

/** The holder puts `ticket` up for sale at `amount`, or takes it off with undefined. */
export const price = (ticket, amount) => hold(ticket, ticket.holder, amount);

/** The holder gives `ticket` to `to`, not for sale. */
export const transfer = (ticket, to) => hold(ticket, to);
