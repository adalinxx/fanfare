# Fanfare

Every artist gets their own coin. Fans earn it by mining or buy it, and spend
it on tickets, merch and paid questions. Tickets and other purchases are
tokens that their holders can transfer and resell.

Each artist is a chain under `Nexus/fanfare` (for example `Nexus/fanfare/band`),
and the artist's coin is that chain's coin. The chain is the database; the
client is the app.

## Records

```
item/<artist>/<name>                        listing: {kind, title, venue, date, media, closed?}
user/<artist>/answer/<id>        the artist's answer to a question
user/<artist>/staff/<staff>                 a door staff key the artist trusts
index/checkin/<artist>/<id>/<staff>   ticket used at the door

own/<artist>/<id>                           a ticket; value = <holder> or <holder>@<price>

user/<fan>/question/<artist>/<id>   question text
user/<fan>/ship/<artist>/<id>       shipping address, encrypted to the artist
```

Each ticket is its own token, named by the artist, for example
`berlin-night-1/A12`; a show's tickets share its listing's name as a prefix.
The artist mints tickets, usually at a price (`<artist>@250`); a fan buys one
by paying that price, and can transfer it or sell it again at any price,
forever. Prices are plain decimals with no leading zeros. A Q&A session is a
listing whose tickets are question slots; merch is a listing whose tickets
are the items, and the holder of one leaves a shipping address sealed to the
artist.

Profiles are not on artist chains: an artist's name, picture and site are
their card on the shared profile chain, `Nexus/profile` (`lattice-profile`),
keyed by address like every app's. Fanfare adds one field there,
`app.fanfare.x25519`, the key fans seal shipping addresses to.

## Who an artist is

The artist of a chain is the account its genesis paid the premine to: only
whoever created the chain could choose it. Names are first come, so the client
shows an artist as verified only when the chain, the profile and the artist's
own site point at one another: the card's `url` is an https site, and
`https://<site>/.well-known/lattice` lists the artist's address (plain text,
one address per line, served with `Access-Control-Allow-Origin: *`).

## Policy

`policy/` is the default policy for an artist chain. The artist chooses their
chain's policy at launch and may use a different one; the client relies on
the token rules below only when a chain runs this module.

- `user/<owner>/…` and `index/…/<owner>`: the owner must sign.
- `item/<artist>/<name>`: the artist must sign. A listing can be edited but
  never deleted, because its tickets point at it.
- `own/…`, minted (no old value): the artist signs, so every ticket is backed
  by the artist. Nothing caps how many; fans see every ticket minted under a
  show's prefix.
- `own/…`, changed by its holder: anything (transfer, set or change a price,
  take it off sale).
- `own/…`, changed by anyone else: only if it has a price, and the
  transaction credits the holder at least the prices of all tokens it takes
  from them.
- `own/…`, deleted, or left without a holder: refused.

A buyer's transaction names the price it read as the old value, so if the
holder changes the price first, the purchase is refused instead of paying a
different price. The client checks the rest: whether a ticket was checked in
by the artist or by staff the artist lists.

## Launch

An artist launches their chain from their own node. The app proposes the spec
in `chain/spec.json` (`client/launch.mjs` builds it): rewards start at 1,000
and halve every 210,000 blocks, and the premine is 21,000 blocks' rewards,
21,000,000 coin, paid to the artist at genesis. Every field is the artist's
to change, the policy included.

```
lattice child create Nexus/fanfare            # once, if the node doesn't host it yet
lattice child create Nexus/fanfare/<name> --spec spec.json \
  --policy-module fanfare_policy.wasm --premine-to <artist address>
```

The node mines the chain's genesis in its next template, and that genesis
pays the premine to `--premine-to`. Names are first come.

## Client

`client/` is the app's library; it runs in a page or in Node.

- `state.mjs` reads state from any node, verifying every trie node by CID,
  reads the chain's spec from the tip block, and finds the artist in the
  genesis block (`premineRecipient`).
- `read.mjs` reads listings, tickets, a fan's tickets, check-ins, Q&A and
  shipping records, and `runsFanfare(spec)` tells the Fanfare policy from a
  custom one.
- `write.mjs` builds the writes: listings, minting, buying, pricing,
  transfers, questions, answers, staff and check-ins. A ticket change names
  the value the writer read, so a stale view is refused, never misapplied.
- `launch.mjs` is the default spec, its premine and the create command.
- `wallet.mjs` turns a write into a request for the Lattice wallet
  (`window.lattice.writeRecords`): Fanfare keeps no key, and the wallet
  shows, signs and sends every write, payments included.
- `market.mjs` lists the offers for an artist's coin and writes the wallet's
  `lattice://order` requests to sell or take them.
- `refusal.mjs` says why a write didn't land: it re-reads the keys the
  write named and reports, per key, what stands in the way (sold to someone
  else, price changed, not yours to change, not enough coin, ...). The node
  answers every refusal with the same `invalidState`.
- `verify.mjs` is the name check above.
- `ship.mjs` seals a shipping address to the artist. The artist's key comes
  from their wallet signing a fixed text, so Fanfare stores no key and the
  same account always gets the same key back.
- `door.mjs` is the door check: a one-time challenge the holder's wallet
  signs (`signMessage`), bound to Fanfare's origin.

The client tests run every transaction they build through the built policy
before applying it:

```
LATTICE_SDK=<lattice-sdk>/packages/sdk/dist/index.js node --test client/*.test.mjs
```

The real-node test (`e2e/transfers.mjs`, header has the command) mines an
artist chain on a private node and buys, resells and transfers tickets
through the client.

## Policy build and test

```
cd policy
cargo build --release --target wasm32-unknown-unknown
LATTICE_SDK_CORE=<lattice-sdk>/packages/core/dist/index.js node --test test/policy.test.mjs
```

To replay every test context through Lattice's own policy host, run the tests
with `CONTEXT_DIR=<dir>`, then `swift run --package-path host-check host-check
target/wasm32-unknown-unknown/release/fanfare_policy.wasm <dir>`.
