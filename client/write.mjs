// Builds the transactions that write records. A record change is a
// general-state action `{ key, oldValue?, newValue? }`: consensus applies it
// only when `oldValue` is what the key holds now, so a change is always made
// against a state root the writer has read.
import { get } from "./state.mjs";

/** The action that sets `key` to `newValue`, or deletes it when undefined. */
export async function change(load, rootCID, key, newValue) {
  const oldValue = await get(load, rootCID, key);
  return {
    key,
    ...(oldValue !== undefined && { oldValue }),
    ...(newValue !== undefined && { newValue }),
  };
}

/** A transaction body carrying `actions`, signed for and paid by `owner`. */
export function transaction({ owner, actions, fee, nonce, chainPath }) {
  return {
    accountActions: fee > 0n ? [{ owner, delta: -fee }] : [],
    actions,
    depositActions: [],
    receiptActions: [],
    withdrawalActions: [],
    signers: [owner],
    nonce,
    chainPath: [...chainPath],
  };
}
