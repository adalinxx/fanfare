# Fanfare web app

A static page: open `app/index.html` from any static host (it imports
`../client/`). It reads every record by CID from the node in Settings
(`?node=<url>` sets it too), checks it in the page, and asks the Lattice
wallet (`window.lattice`) to sign: the page keeps no key and has no server.

- **Home** (`#/`) lists the shows coming up, soonest first, across every
  artist on the Fanfare chain and on their own coin's chain, then the
  artists, by the name on their Moniker profile, with a check mark only when
  the site on that profile lists their address (see the main README, "Who an
  artist is"). Nothing is shown for an artist who hasn't set that up.
- **Sell** (`#/sell`) puts a show, merch or paid questions on sale from the
  connected wallet on the Fanfare chain: a title, a date and venue, how many
  and a price, minted in one write. It then links the artist's page.
- **An artist's page** (`#/a/<name>` for their own coin's chain,
  `#/a/@<address>` on the Fanfare chain) shows their shows by date, Q&A and
  merch. One button buys the cheapest ticket still good; resales are listed
  with what the ticket cost new. A ticket already checked in, or a slot
  already answered, is marked, and a buyer is warned. A Q&A listing says how
  many days the artist aims to answer in and their record so far.
  Buying a Q&A slot asks the question in the same write; buying merch seals
  the shipping address to the artist in the same write. An artist with their
  own coin has a coin panel: what it's for, that its price can fall to
  nothing, and the market's offers, handed to the wallet as a
  `lattice://order`. The artist sees their own tools here: what needs doing
  (questions to answer, orders to ship), new listings, door staff, and
  shipping addresses, opened with a key their wallet derives and marked
  shipped.
- **My tickets** (`#/me`) is what the connected account holds, by upcoming
  show, question and merch: a door pass as a QR code, a resale price, or
  giving it to an @handle or address, confirmed by name. A pass is signed
  once and kept in the browser; it can be saved as an image or opened on a
  phone from a second QR code (`#/pass/<pass>`, which needs no wallet).

A door pass and the artist's shipping key are both signed for the site the
page runs on. A door accepts passes from its own site and any Fanfare sites
listed in Settings. An artist who opens addresses on another site gets
another key, and the page says so before replacing the published one.
- **Door** (`#/door/<artist>/<show>`) is one show's door. It reads a pass
  (or a pass link) from the camera (where the browser has
  `BarcodeDetector`) or pasted, checks it is for this show, signed by the
  ticket's holder now on an accepted Fanfare site and not used yet, writes
  the check-in, and says "Let them in" once the check-in has landed. A
  ticket this door let in is turned away at once after. Two doors scanning
  the same pass within one block can both admit it.
- **Your own coin** (`#/launch`) says what changes and what doesn't, checks
  the name is free, and gives the artist their spec, the policy module and
  the command for their node, with the premine paid to their wallet's
  address.

A purchase shows its price, fee and total before the wallet asks, and checks
the balance first; buying coin
shows what the whole offers it takes come to, and asks again. Every write says
"Confirming…" until it lands. When it doesn't, the page re-reads what the write
named and says why: sold to someone else, the price changed, not enough coin.

```sh
python3 -m http.server 8765   # from the repository root, then open
                              # http://127.0.0.1:8765/app/?node=<node URL>
```

`vendor/` holds the browser bundle of `@adalinxx/lattice-sdk`
(`esbuild --bundle --format=esm`, as Stoa's), `qrcode-generator` 2.0.4
(MIT), and Moniker's `src/records/profile.mjs` (github.com/adalinxx/moniker-sdk, tag v0.1.1). The
fonts in `fonts/` are Bricolage Grotesque and Instrument Sans (SIL Open Font
License), shipped with the page so no font host sees who visits.
`fanfare_policy.wasm` is the built policy, offered at launch; a UI test
checks it matches `policy/`'s build.

The UI tests (`e2e/ui/`) drive the page in headless Chromium against a
private node; the file's header has the command.
