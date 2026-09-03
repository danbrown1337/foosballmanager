# Fantasy Manager — Chrome extension

A point-and-click draft assistant, roster viewer, and trade-offer generator
for Yahoo Fantasy Football, running entirely inside your browser. No server,
no Python, no pending Yahoo API approval — it reads the page you're already
looking at, the same way `browser_sync.py` does for the CLI, just built into
the browser itself instead of driven from a terminal.

## Platform: the Yahoo Fantasy **website**, not the app

A Chrome extension can only run inside browser tabs — it has no way to reach
a native iOS/Android app. If your league's roster requirements came from a
screenshot of the Yahoo Fantasy phone app, that's fine for telling the
engine your league's rules (see `config/league.yaml`), but this extension
itself only works on `https://*.fantasysports.yahoo.com/*` in a desktop or
mobile Chrome browser tab. Live draft rooms run on the website anyway, so
this is where drafting actually happens for most people.

## What it does, and what it deliberately doesn't

| | |
|---|---|
| **Draft** | Recommends a pick with reasoning (same engine as the CLI's `autopick`), tracks who's gone, and can auto-detect opponent picks by watching the page. |
| **Manage** | View your roster and positional scarcity in the popup. |
| **Trades** | Generates lowball offers as text for you to send yourself. |

**It never clicks, fills in, or submits anything in Yahoo's own UI.** There
is no code anywhere in this extension that automates an actual draft pick,
roster move, or trade — you always take the real action in Yahoo's own
interface yourself. That's the same call already made for trades throughout
this project (Yahoo's API is read-only, and scripting the actual sends risks
looking like bot activity against Yahoo's terms) — extended here to drafting
and roster moves too, since a script clicking through a live draft against
real opponents is a materially bigger step than a script reading a page for
your own research. If you want it to go further than that, that's a
deliberate line someone should decide to cross with eyes open, not something
that ships by default.

**Honest scope note:** the CLI's `roster_manager.py` also has `byeweeks`,
`overachievers`, and `waivers` commands. Those aren't ported here yet — the
extension currently covers drafting and trade offers fully, and roster
viewing partially (your team + scarcity, not bye-week conflicts or waiver
targets). Use the CLI or `python3 -m fantasy_manager.web` for those.

## Install (load unpacked — no Chrome Web Store, no build step)

1. `python3 scripts/build_extension_data.py` from the repo root, if
   `extension/data/*.json` isn't already there or `data/*.csv` changed.
2. Open `chrome://extensions`, enable **Developer mode** (top right).
3. **Load unpacked** → select this `extension/` folder.
4. Pin it (puzzle-piece icon → pin) so the popup is one click away.
5. Open **Settings** (gear icon in the popup, or right-click the extension
   icon → Options) and set your league's real starters, team count, and
   scoring. The defaults already match the confirmed real construction —
   1 QB, 2 RB, 2 WR, 1 TE, 2 W/R/T flex, 1 DEF, no kicker — but team count
   and scoring are still guesses.

Nothing here needs `npm install` to run — vanilla JS, ES modules, no
bundler. `npm`/Playwright are only used by the test scripts below, and only
if you want to re-run them.

## Draft day

Open the popup on any Yahoo Fantasy page (or on your draft room specifically,
where the small floating panel also appears on the page itself). Click **the
recommended player's Mine/Taken buttons**, or **"Draft this player for
me"** on the top card to take the current recommendation.

If you turn on watching (the floating panel on the page, which polls every
few seconds), it auto-detects opponent picks by searching the page's own
text for the ~190 names on the ADP board — no CSS selectors to break, and it
can't invent a player who doesn't exist. It never guesses which pick was
**yours** — that's always the explicit "I drafted this player" click, the
same split the CLI's `browser_sync.py watch` uses (auto-detects rivals,
commits your own pick deliberately).

## Where your data lives

Everything is stored in `chrome.storage.local` — on your machine only,
scoped to the Chrome profile the extension is installed in. Nothing is sent
anywhere; there's no server. Installing the extension in a separate Chrome
profile is a natural way for two people to each have their own setup,
mirroring the CLI's `--profile` system without needing to build one from
scratch here.

## Development

Zero npm dependencies for the extension itself. Tests use Node's built-in
test runner and a golden-master comparison against the Python engine:

```bash
bash extension/test/run_all.sh
```

This runs:
- `node --test` unit tests for the page-text parsing (`textMatch.js`) and
  the trade offer generator (`tradeTargeter.js`).
- A **golden-master comparison**: `scripts/simulate_draft.py` runs a full
  mock draft through the real Python `auto_pick()` engine (every team
  drafting, all four guardrails engaging), dumps the exact pick sequence,
  and `compare_with_python.js` replays the identical draft through the
  ported JS engine and diffs every pick. This is run across four different
  league configs (`extension/test/fixtures/`) — with and without a kicker,
  every autopilot strategy, every risk tolerance — 640 picks compared
  exactly with zero mismatches. Regenerate the fixtures with
  `python3 scripts/simulate_draft.py <config.yaml> > <output>.json`
  whenever `autopilot.py` or `board.py` changes.

Loading the actual unpacked extension in a real browser and checking for
JS errors (popup, options, and the content script's declarative injection
on a real page) needs Playwright, which is **not** a dependency of the
extension — install it separately if you want to re-run that check:

```bash
npm install playwright   # in a scratch directory, not this one
```

## Known limits

- The floating panel's mode dropdown (`names appear` / `names disappear`)
  controls which direction signals a pick, same as the CLI's
  `browser_sync.py watch --mode`. Pick the wrong one and nothing gets
  detected rather than something wrong getting detected — check the panel's
  log after your first couple of picks; if nothing shows up, switch it.
  The choice is remembered across page loads.
- Never tested against a real Yahoo draft room — this environment couldn't
  reach `fantasysports.yahoo.com` to verify. It was verified by injecting
  the actual content script into a real Chromium via Chrome's own
  declarative content-script mechanism, on a local test page built to
  exercise the exact same code path in both modes: panel injection,
  recommendation rendering, detecting a name that *appears* via a live
  in-page DOM update, detecting one that *disappears*, and the mode choice
  surviving a reload. **Try it against a real mock draft before draft
  day**, the same advice the CLI's README already gives for
  `browser_sync.py watch`.
