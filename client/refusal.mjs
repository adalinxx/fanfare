// Why a write did not land. The node answers every refused write with the same
// `invalidState`, and a write it admitted can still lose its key to another
// one mined first, so the client asks the chain instead: it re-reads every key
// the write named and says, per key, what stands in the way.
import { holding } from "./read.mjs";

const OWN = /^own\/([^/]+)\/(.+)$/;
const OWNED = /^(?:user\/([^/]+)\/|index\/.+\/([^/]+)$|item\/([^/]+)\/)/;

const describe = (value) => {
  const held = holding(value);
  return held && (held.price === undefined ? `held by ${held.holder}` : `for sale by ${held.holder} at ${held.price}`);
};

/**
 * Why the token at `key` stopped matching what the writer read (`oldValue`),
 * now that it holds `now`, for `me`.
 */
function tokenMoved(oldValue, now, me) {
  const [was, is] = [holding(oldValue), holding(now)];
  if (!is) return { reason: "gone", text: "This ticket no longer exists." };
  if (is.holder === me && was?.holder !== me) return { reason: "yours", text: "This ticket is already yours." };
  if (!was) return { reason: "minted", text: `This ticket was just minted; it is ${describe(now)}.` };
  if (was.holder !== is.holder)
    return was.price !== undefined
      ? { reason: "sold", text: "Someone else got this ticket first." }
      : { reason: "moved", text: `This ticket changed hands; it is ${describe(now)}.` };
  if (is.price === undefined) return { reason: "off-sale", text: "The holder took this ticket off sale." };
  return { reason: "price", text: `The price changed to ${is.price}.` };
}

/** Why the policy refuses this change to a token when it matches state. */
function tokenRule(artist, { oldValue, newValue }, me, paid) {
  if (newValue === undefined) return { reason: "permanent", text: "Tickets can't be deleted." };
  if (!holding(newValue)) return { reason: "malformed", text: "A ticket must name its holder." };
  if (oldValue === undefined)
    return me === artist ? undefined : { reason: "not-artist", text: "Only the artist can mint tickets." };
  const was = holding(oldValue);
  if (!was || was.holder === me) return undefined;
  if (was.price === undefined) return { reason: "not-for-sale", text: "This ticket isn't for sale." };
  if ((paid.get(was.holder) ?? 0n) < was.price)
    return { reason: "underpaid", text: `This ticket costs ${was.price}.` };
  return undefined;
}

/**
 * Why `write` (`{ actions, payments? }`, as write.mjs builds it) by `me` did
 * not land, read against `state`, the chain as it is now: a list of
 * `{ key, reason, text }`, one per action that stands in the way. With
 * `balance`, `me`'s coin now, a write that costs more says so. An empty list
 * means every key still reads as the write expects: the write may yet land.
 * The write landed only when every action reads `done` (`landed`).
 */
export async function explain(state, { actions, payments = [] }, me, { balance, fee = 1n } = {}) {
  const paid = new Map();
  for (const { to, amount } of payments) paid.set(to, (paid.get(to) ?? 0n) + amount);
  const found = [];
  for (const action of actions) {
    const now = await state.get(action.key);
    const token = OWN.exec(action.key);
    let why;
    if (now === action.newValue) why = { reason: "done", text: "Already done." };
    else if (now !== action.oldValue)
      why = token
        ? tokenMoved(action.oldValue, now, me)
        : { reason: "changed", text: "This changed since you looked; look again." };
    else if (token) why = tokenRule(token[1], action, me, paid);
    else {
      const owner = OWNED.exec(action.key)?.slice(1).find(Boolean);
      if (owner !== me) why = { reason: "not-yours", text: "Only its owner can change this." };
      else if (action.key.startsWith("item/") && action.newValue === undefined)
        why = { reason: "permanent", text: "Listings can't be deleted; close it instead." };
    }
    if (why) found.push({ key: action.key, ...why });
  }
  const cost = fee + [...paid.values()].reduce((sum, amount) => sum + amount, 0n);
  if (balance !== undefined && balance < cost)
    found.push({ key: undefined, reason: "funds", text: `This needs ${cost} coin; you have ${balance}.` });
  return found;
}

/** Whether `explain`'s answer for `write` says it landed: every action reads as written. */
export const landed = (write, why) =>
  why.length === write.actions.length && why.every((w) => w.reason === "done");
