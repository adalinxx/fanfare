// A private Lattice stack for the page's tests: one node mines Nexus, the
// shared profile chain, the Fanfare chain (where the artist sells from their
// wallet) and one artist's own coin chain, each launched with its premine to
// the artist, and serves the page from a local static server. The artist has
// a Moniker card; Alice and Bob have FAN from the artist.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import * as door from "../../client/door.mjs";
import * as launch from "../../client/launch.mjs";
import * as wallet from "../../client/wallet.mjs";
import * as write from "../../client/write.mjs";

export const sdk = await import(process.env.LATTICE_SDK);
export const here = (path) => fileURLToPath(new URL(path, import.meta.url));
export const HOME = launch.HOME;
export const CHAIN = launch.chainPath("band");
export const PROFILE = ["Nexus", "moniker"];
export const SECONDS = Number(process.env.E2E_SECONDS ?? 300);

export async function until(label, condition, seconds = SECONDS) {
  const deadline = Date.now() + seconds * 1000;
  let failure;
  for (;;) {
    const value = await condition().catch((error) => void (failure = error));
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`, { cause: failure });
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/** Ed25519 over "lattice-message:" + origin + "\n" + text, as the wallet signs. */
export async function signMessage(who, origin, text) {
  const pkcs8 = new Uint8Array([...sdk.hexToBytes("302e020100300506032b657004220420"), ...who.privateKey]);
  const key = await crypto.subtle.importKey("pkcs8", pkcs8, "Ed25519", false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", key, door.signedBytes(origin, text)));
  return { publicKey: who.publicKey, signature: sdk.bytesToHex(signature) };
}

/**
 * Starts the stack on `ports` (`{ listen, rpc, publicRead, app }`); `profileDir`
 * is a Moniker checkout. Resolves once the chains have their premines, the
 * fans their FAN, and the page server answers.
 */
export async function start(ports, profileDir) {
  assert.ok(profileDir, "MONIKER names the moniker checkout");
  const root = mkdtempSync(`${tmpdir()}/fanfare-ui-`);
  const node = `http://127.0.0.1:${ports.publicRead}`;
  const origin = `http://127.0.0.1:${ports.app}`;
  const lattice = (...args) => execFileSync(process.env.LATTICE, [...args, "--root", root], { encoding: "utf8" });
  const configure = (change) => {
    const file = `${root}/lattice.json`;
    const topology = JSON.parse(readFileSync(file, "utf8"));
    change(topology);
    writeFileSync(file, JSON.stringify(topology, null, 2));
  };
  const account = () => {
    const privateKey = sdk.generatePrivateKey();
    return { ...sdk.accountFromPrivateKey(privateKey), keyHex: Buffer.from(privateKey).toString("hex") };
  };
  const [miner, artist, alice, bob] = [account(), account(), account(), account()];

  async function api(path, chain) {
    const url = new URL(path, node);
    url.searchParams.set("chainPath", chain.join("/"));
    const response = await fetch(url, { cache: "no-store" });
    return response.ok ? response.json() : undefined;
  }
  const balance = async (who, chain = HOME) => BigInt((await api(`/api/state/account/${who.address}`, chain))?.balance ?? 0);

  /** What the wallet does with a writeRecords request: nonce from its node, the body, the signature, the send. */
  async function send(who, request) {
    const body = write.transaction({
      owner: who.address,
      actions: request.actions,
      payments: (request.payments ?? []).map(({ to, amount }) => ({ to, amount: BigInt(amount) })),
      fee: BigInt(request.fee),
      nonce: BigInt((await api(`/api/state/account/${who.address}`, request.chainPath))?.nonce ?? 0),
      chainPath: request.chainPath,
    });
    const { publicKey, signature } = sdk.signTransactionBody(body, who.privateKey);
    const response = await fetch(new URL("/transactions", node), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(sdk.transactionPayload({ [publicKey]: signature }, body)),
    });
    const text = await response.text();
    return response.ok ? { ok: true, transactionCID: JSON.parse(text).transactionCID ?? "" } : { ok: false, error: `The node refused it: ${text}` };
  }

  lattice("init");
  configure((topology) => {
    Object.assign(topology, { listen: ports.listen, rpc: ports.rpc, publicRead: ports.publicRead, webSocket: 0, publicSubmit: true });
    // The artist's page keeps show images on this node.
    topology.rpcAllowedOrigins = [origin];
    topology.publicReadExpensiveRate = 1000;
    topology.publicReadRate = 1000;
    topology.peers = [];
    topology.mine = { worker: "cpu", workers: 1, batchSize: 100000 };
  });
  lattice("child", "create", PROFILE.join("/"), "--spec", `${profileDir}/chain/spec.json`,
    "--policy-module", `${profileDir}/chain/moniker_policy.wasm`, "--premine-to", artist.address);
  // The Fanfare chain runs the Fanfare policy, as the trial does.
  const specFile = `${root}/spec.json`;
  writeFileSync(specFile, JSON.stringify(launch.spec()));
  const policy = here("../../app/fanfare_policy.wasm");
  lattice("child", "create", HOME.join("/"), "--spec", specFile, "--policy-module", policy, "--premine-to", artist.address);
  lattice(...launch.createArguments({ name: "band", specFile, moduleFile: policy, artist: artist.address }));
  configure((topology) => {
    topology.mine.recipients = Object.fromEntries([HOME, CHAIN, PROFILE].map((c) => [c.join("/"), miner.address]));
  });
  lattice("up");
  lattice("mine", "start");
  const server = spawn("python3", ["-m", "http.server", String(ports.app), "--bind", "127.0.0.1"], { cwd: here("../.."), stdio: "ignore" });
  const stop = () => {
    server.kill();
    try { lattice("mine", "stop"); } catch {}
    try { lattice("down"); } catch {}
  };
  try {
    await until("the premines", async () => (await balance(artist)) > 0n && (await balance(artist, CHAIN)) > 0n && (await balance(artist, PROFILE)) > 0n);
    // Fans get FAN from the artist; the market's legs are the wallet's.
    const funding = wallet.writeRequest(HOME, { actions: [{ key: `user/${artist.address}/hello`, newValue: "1" }], payments: [{ to: alice.address, amount: 2000n }, { to: bob.address, amount: 2000n }] });
    assert.ok((await send(artist, funding)).ok);
    await until("fans funded", async () => (await balance(bob)) === 2000n);
    // The artist's card on Moniker: a name, a site that doesn't list them back, a link.
    const card = { name: "The Band", url: "https://band.invalid", links: [{ label: "Bandcamp", url: "https://band.invalid/music" }] };
    assert.ok((await send(artist, wallet.writeRequest(PROFILE, { actions: [{ key: `user/${artist.address}/profile`, newValue: JSON.stringify(card) }] }))).ok);
    await until("the card", async () => (await balance(artist, PROFILE)) < launch.premineAmount(launch.spec()));
    await until("the page server", () => fetch(`${origin}/app/`).then((r) => r.ok), 20);
  } catch (error) {
    stop();
    throw error;
  }
  return {
    root, node, origin, rpc: `http://127.0.0.1:${ports.rpc}`,
    app: `${origin}/app/?${new URLSearchParams({ node, home: HOME.join("/"), profile: PROFILE.join("/") })}`,
    cookie: () => readFileSync(`${root}/chains/Nexus/.cookie`, "utf8").trim(),
    miner, artist, alice, bob, balance, send, stop,
  };
}
