# Fanfare web app

A static page: open `app/index.html` from any static host (it imports
`../client/`). It reads every record by CID from the node in Settings
(`?node=<url>` sets it too), checks it in the page, and asks the Lattice
wallet (`window.lattice`) to sign: the page keeps no key and has no server.

- **Artists** (`#/`) lists every chain under the home chain, with the name
  and picture from each artist's profile on Moniker (`Nexus/moniker`), and a check mark
  only when the site on that profile lists the artist's address (see the
  main README, "Who an artist is").
- **An artist's page** (`#/a/<name>`) shows their shows, Q&A and merch, with
  every ticket for sale, the artist's and fans' resales, cheapest first; a
  ticket already checked in, or a slot already answered, is marked, and a
  buyer is warned.
  Buying a Q&A slot asks the question in the same write; buying merch seals
  the shipping address to the artist in the same write. The coin panel lists
  the market's offers and hands the wallet a `lattice://order`. The artist
  sees their own tools here: new listings (minted in one write), questions
  waiting for an answer, door staff, and shipping addresses, opened with a
  key their wallet derives.
- **My tickets** (`#/me`) is what the connected account holds on every
  artist chain: a door pass as a QR code (signed by the wallet, good for two
  minutes), a resale price, or giving it away.

A door pass and the artist's shipping key are both signed for the site the
page runs on. A door accepts passes from its own site and any Fanfare sites
listed in Settings. An artist who opens addresses on another site gets
another key, and the page says so before replacing the published one.
- **Door** (`#/door/<name>/<show>`) is one show's door. It reads a pass from
  the camera (where the browser has `BarcodeDetector`) or pasted, checks it
  is for this show, signed by the ticket's holder on an accepted Fanfare
  site and not used yet, writes the check-in, and says "Let them in" once
  the check-in has landed. A ticket this door let in is turned away at once
  after. Two doors scanning the same pass within one block can both admit
  it.
- **Launch** (`#/launch`) checks the name is free and gives the artist their
  spec, the policy module and the command for their node, with the premine
  paid to their wallet's address.

A purchase shows its price and fee before the wallet asks; buying coin
shows what the whole offers it takes come to, and asks again. Every write says
"Waiting for a block…" until it lands. When it doesn't, the page re-reads what the write
named and says why: sold to someone else, the price changed, not enough coin.

```sh
python3 -m http.server 8765   # from the repository root, then open
                              # http://127.0.0.1:8765/app/?node=<node URL>
```

`vendor/` holds the browser bundle of `@adalinxx/lattice-sdk`
(`esbuild --bundle --format=esm`, as Stoa's), `qrcode-generator` 2.0.4
(MIT), and Moniker's `client/profile.mjs` (`~/src/moniker`, commit 0cea0cb). The
fonts in `fonts/` are Bricolage Grotesque and Instrument Sans (SIL Open Font
License), shipped with the page so no font host sees who visits.
`fanfare_policy.wasm` is the built policy, offered at launch; a UI test
checks it matches `policy/`'s build.

The UI tests (`e2e/ui/`) drive the page in headless Chromium against a
private node; the file's header has the command.
