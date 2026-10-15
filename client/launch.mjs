// An artist's launch: their chain under Nexus/fanfare, from a spec the artist
// owns. The app proposes the defaults below; every field is the artist's to
// change, the policy included. The artist's own node creates the chain and
// mines its genesis, which pays the premine to the artist.
import { FANFARE_POLICY } from "./read.mjs";

/** The home chain every artist chain sits under. */
export const HOME = ["Nexus", "fanfare"];

/** The Fanfare policy as a spec names it. */
export const fanfarePolicy = {
  moduleCID: FANFARE_POLICY,
  abiVersion: 1,
  scope: "transaction",
  entrypoint: "lattice_validate_transaction",
};

/**
 * The app's proposed spec. `premine` counts blocks of the reward schedule:
 * 21,000 blocks of 1,000 is 21,000,000 coin to the artist at genesis, a tenth
 * of the first halving era, and mining carries on from there.
 */
export const defaults = {
  maxNumberOfTransactionsPerBlock: 1000,
  maxStateGrowth: 1000000,
  maxBlockSize: 1000000,
  premine: 21000,
  targetBlockTime: 10000,
  initialReward: 1000,
  halvingInterval: 210000,
  halfLife: 100,
  wasmPolicies: [fanfarePolicy],
};

/** The artist's spec: the defaults with their `changes`. */
export const spec = (changes = {}) => ({ ...defaults, ...changes });

/**
 * The coin a spec's genesis pays: the rewards of its first `premine` blocks,
 * halving every `halvingInterval`, as Lattice computes it.
 */
export function premineAmount({ premine, initialReward, halvingInterval }) {
  let total = 0n;
  for (let done = 0n, era = 0n; done < BigInt(premine) && era < 64n; era++) {
    const reward = BigInt(initialReward) >> era;
    if (reward === 0n) break;
    const blocks = [BigInt(halvingInterval) * (era + 1n) - done, BigInt(premine) - done].reduce((a, b) => (a < b ? a : b));
    total += blocks * reward;
    done += blocks;
  }
  return total;
}

/** An artist chain's path under `home`. A name is one non-empty path segment, first come. */
export function chainPath(name, home = HOME) {
  if (typeof name !== "string" || name === "" || name.includes("/")) throw new Error(`bad artist name: ${name}`);
  return [...home, name];
}

/**
 * The `lattice` arguments that create the artist chain on the artist's node:
 * `specFile` holds `spec`, `moduleFile` the policy module it names.
 */
export function createArguments({ name, specFile, moduleFile, artist, home = HOME }) {
  return [
    "child", "create", chainPath(name, home).join("/"),
    "--spec", specFile,
    ...(moduleFile ? ["--policy-module", moduleFile] : []),
    "--premine-to", artist,
  ];
}
