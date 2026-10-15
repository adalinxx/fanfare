// Fanfare keeps no key: every write goes to the person's Lattice wallet
// through `window.lattice.writeRecords`, which shows it, picks the nonce,
// signs with the connected account and sends it. The wallet debits that
// account for the payments plus the fee and credits each payee, the same
// body write.mjs `transaction` builds.

/**
 * The wallet request for `actions` on `chainPath`, paying `payments`
 * (`{ to, amount }`, as write.mjs `buy` returns them) from the connected
 * account. The wallet takes each payee once, so payments to one payee are
 * added together.
 */
export function writeRequest(chainPath, { actions, payments = [] }, fee = 1n) {
  if (actions.length === 0) throw new Error("Nothing to write");
  const credits = new Map();
  for (const { to, amount } of payments) credits.set(to, (credits.get(to) ?? 0n) + amount);
  return {
    chainPath: [...chainPath],
    actions,
    ...(credits.size > 0 && { payments: [...credits].map(([to, amount]) => ({ to, amount: String(amount) })) }),
    fee: String(fee),
  };
}

/** Asks the wallet to approve, sign and send the write. Resolves to `{ transactionCID }`. */
export const send = (lattice, chainPath, write, fee) => lattice.writeRecords(writeRequest(chainPath, write, fee));
