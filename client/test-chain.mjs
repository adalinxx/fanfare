// A chain in memory for the client tests.
import { context, validate } from "../policy/test/host.mjs";
import * as write from "./write.mjs";

/**
 * A chain in memory that admits a transaction the way consensus would: every
 * action's old value must be what the key holds, the built Fanfare policy
 * must accept the body, and no balance may go below zero.
 */
export function chain(sdk, PATH, balances) {
  const map = new Map();
  const coins = new Map(Object.entries(balances).map(([who, amount]) => [who, BigInt(amount)]));
  const state = {
    get: async (key) => map.get(key),
    async *list(prefix) {
      for (const key of [...map.keys()].sort()) if (key.startsWith(prefix)) yield [key, map.get(key)];
    },
  };
  let nonce = 0n;
  function submit(owner, actions, payments = []) {
    const body = write.transaction({ owner, actions, payments, fee: 1n, nonce: nonce++, chainPath: PATH });
    for (const { key, oldValue } of actions) if (map.get(key) !== oldValue) return false;
    if (!validate(context(sdk.encodeTransactionBody(body).bytes, { path: PATH }))) return false;
    const after = new Map(coins);
    for (const { owner: who, delta } of body.accountActions) after.set(who, (after.get(who) ?? 0n) + delta);
    if ([...after.values()].some((amount) => amount < 0n)) return false;
    for (const [who, amount] of after) coins.set(who, amount);
    for (const { key, newValue } of actions) {
      if (newValue === undefined) map.delete(key);
      else map.set(key, newValue);
    }
    return true;
  }
  return {
    state,
    balance: (who) => coins.get(who) ?? 0n,
    submit,
    /** Writes `[key, value]` pairs by `owner`, against the current state. */
    write: async (owner, writes) => submit(owner, await write.changes(state, writes)),
  };
}

