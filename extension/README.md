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
| **Draft** | Recommends a pick with reasoning (same engine as the CLI's `autopick`), tracks who's gone, can auto-detect opponent picks by watching the page, and — opt-in, off by default — can auto-fill your own pick when it's your turn. See **Auto-draft** below. |
| **Manage** | View your roster and positional scarcity in the popup. |
| **Trades** | Generates lowball offers as text for you to send yourself. |

**By default it never clicks, fills in, or submits anything in Yahoo's own
UI.** Roster moves and trades are never automated, full stop — you always
take those actions yourself in Yahoo's own interface. That's the same call
already made for trades throughout this project (Yahoo's API is read-only,
and scripting real sends risks looking like bot activity against Yahoo's
terms). Drafting is the one deliberate, opt-in exception — see below —
because it's the one action here explicitly requested to be automated;
everything else stays a line someone decides to cross with eyes open, not
something that ships by default.

## Auto-draft (experimental, opt-in, off by default)

Turn it on from the floating panel on the draft room page itself. Two
levels, both starting off:

1. **Auto-draft when it's my turn** — watches the page's text for an
   "it's your turn" phrase. When it finds one, it locates the recommended
   player on the page (same text-search strategy as everything else here —
   see `lib/domActions.js`) and clicks it, then **stops**. Selecting a
   player is easy to undo — nothing has been submitted to Yahoo yet — so
   that click is the safe part to automate by default. The actual "confirm
   this pick" click is not undoable, and stays yours.
2. **Fully automatic** (a sub-toggle, only shown once auto-draft is on) —
   also finds and clicks Yahoo's own Confirm/Draft button, with a short
   randomized pause before each click. Nothing stops you from turning this
   on immediately, but it means an unattended click actually submits a
   pick — **test it against a Yahoo mock draft first.**

Both toggles and the recommended player always come from the same trusted
engine already verified pick-for-pick against the CLI (see golden-master,
below) — auto-draft only ever acts on the same recommendation the panel is
already showing you, never a different one.

**Honest limit, same as the rest of this project:** this environment has no
access to `fantasysports.yahoo.com`, so neither the "your turn" phrases nor
the click-target logic have been run against Yahoo's real draft room —
`lib/turnDetect.js`'s default phrases are an educated guess, and
`lib/domActions.js` was verified with a real browser clicking real DOM
elements (`test/domActions.check.js`) on a synthetic page built to cover the
patterns a draft room plausibly uses (a `<button>` row, a plain `<div>` row
with its own click handler, a separate confirm dialog) — not Yahoo's actual
one. If "your turn" never triggers, open **Options** and add whatever phrase
your room actually shows to the turn-phrases list.

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
- `node --test` unit tests for the page-text parsing (`textMatch.js`), the
  trade offer generator (`tradeTargeter.js`), and turn-phrase detection
  (`turnDetect.js`).
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

Two more checks load the actual unpacked extension into a real browser via
Playwright, which is **not** a dependency of the extension — install it
separately (in a scratch directory, or globally) if you want to re-run
them, and point `NODE_PATH`/a local `node_modules` symlink at it since these
files use `import`:

```bash
npm install playwright   # in a scratch directory, not this one
node extension/test/load_check.js       # popup/options load with no JS errors
node extension/test/domActions.check.js # auto-draft click-targeting, on a synthetic page
```

`load_check.js` opens the popup and options pages directly and exercises
them (renders the board, clicks a Mine button, checks the saved defaults).
`domActions.check.js` is the auto-draft click-targeting check described
above — real declarative content-script injection, a real DOM, real
`element.click()` dispatch, on a synthetic page since this environment
can't reach Yahoo. Neither is wired into CI (no Chromium there); both are
one-off checks for this build, not part of the shipped extension.

## Known limits

- **Auto-draft has never run against a live Yahoo draft room.** Its turn
  detection and click-targeting are verified against a real browser and a
  synthetic page, not the real one — see the Auto-draft section above. Run
  it in a Yahoo mock draft first, with "fully automatic" left off, before
  trusting it live. It's off by default for exactly this reason.
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
