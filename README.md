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
user/<artist>/item/<item>                   listing: {kind, title, venue, date, media}
user/<artist>/answer/<item>/<serial>        the artist's answer to a question
user/<artist>/checkin/<item>/<serial>       ticket used at the door

own/<seller>/<item>/<serial>                a token; value = its current holder

user/<fan>/question/<artist>/<item>/<serial>   question text
user/<fan>/ship/<artist>/<item>/<serial>       shipping address, encrypted to the artist

<item> = <price>.<supply>.<closes>.<name>      closes = last block on sale, 0 = never
```

Numbers are plain decimals with no leading zeros. A Q&A session is an item
whose price is the minimum tip and whose supply is the number of questions.

## Policy

`policy/` is the default policy for an artist chain. The artist chooses their
chain's policy at launch and may use a different one; the client relies on
the token rules below only when a chain runs this module.

- `user/<owner>/…` and `index/…/<owner>`: the owner must sign.
- `own/…`, created (no old value): the serial is below the supply, the block
  is at or before `closes` unless it is 0, and the transaction credits the
  seller at least the prices of all tokens it buys from them.
- `own/…`, changed (old value = holder): the holder must sign.
- `own/…`, deleted or emptied: refused.

The client checks the rest: that the seller listed the item, and whether a
ticket was checked in.

Build and test:

```
cd policy
cargo build --release --target wasm32-unknown-unknown
LATTICE_SDK_CORE=<lattice-sdk>/packages/core/dist/index.js node --test test/policy.test.mjs
```

To replay every test context through Lattice's own policy host, run the tests
with `CONTEXT_DIR=<dir>`, then `swift run --package-path host-check host-check
target/wasm32-unknown-unknown/release/fanfare_policy.wasm <dir>`.
