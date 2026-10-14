# Fanfare

Every artist gets their own coin. Fans earn it by mining or buy it, and spend
it on tickets, merch and paid questions. Tickets and other purchases are
tokens that their holders can transfer and resell.

Each artist is a chain under `Nexus/fanfare` (for example `Nexus/fanfare/band`),
and the artist's coin is that chain's coin. The chain is the database; the
client is the app.

## Records

```
user/<artist>/profile                       name, bio, avatar CID, encryption key
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
listing whose tickets are question slots.

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

Build and test:

```
cd policy
cargo build --release --target wasm32-unknown-unknown
LATTICE_SDK_CORE=<lattice-sdk>/packages/core/dist/index.js node --test test/policy.test.mjs
```

To replay every test context through Lattice's own policy host, run the tests
with `CONTEXT_DIR=<dir>`, then `swift run --package-path host-check host-check
target/wasm32-unknown-unknown/release/fanfare_policy.wasm <dir>`.
