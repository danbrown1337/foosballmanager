# Handoff

Where this project stands, for whoever (human or Claude) picks it up next.
Written 2026-09-03.

## What this is

A Yahoo Fantasy Football draft assistant and in-season roster manager, for
Dan's real league: **1 QB, 2 RB, 2 WR, 1 TE, 2 W/R/T flex, 1 DEF, no
kicker** (confirmed from the league's roster screen). Team count and
scoring are still guesses — see "What needs a human" below.

Three ways to use it, all sharing one tested engine so they can never
disagree with each other:

1. **CLI** (`fantasy_manager/`) — `draft_assistant.py`, `roster_manager.py`,
   `trade_targeter.py`, `yahoo_client.py`, `browser_sync.py`.
2. **Web app** (`fantasy_manager/web.py`) — `python3 -m fantasy_manager.web`,
   point-and-click, stdlib only, no terminal literacy needed beyond
   starting it. Supports `--share` for a second person on the same network.
3. **Chrome extension** (`extension/`) — the same engine ported to JS,
   installable via `chrome://extensions` → Load unpacked, no Python needed
   at all. Covers drafting and trade offers fully; roster viewing partially
   (see its own README for the honest gap list). Includes an opt-in,
   off-by-default **auto-draft** that can click your recommended pick (and,
   if separately enabled, Yahoo's own Confirm button) when it's your turn —
   see "The automation boundary" below, it's no longer absolute.

**Repo:** https://github.com/danbrown1337/foosballmanager, branch `main`.
CI: 9 pushes, 9 green, never once red. `README.md` is the user-facing entry
point — start there for setup and commands; this file is project state and
context, not a how-to.

## Read this first if you're a fresh Claude session

- The project lives **only** in `danbrown1337/foosballmanager`. It used to
  be built inside `danbrown1337/practice_makes_perfect` before being moved
  out — if you see that repo mentioned anywhere (old branches, a closed
  PR #1), it's leftover history. **Never push fantasy-manager work there.**
  The user was explicit and annoyed the one time this almost happened.
- If you're picking up a stale local clone of `practice_makes_perfect` in
  this environment: it may have a local `main` branch with ~12 unpushed
  commits sitting on it. Check whether those SHAs already exist on
  `foosballmanager` (they very likely do, via `git cat-file -e` after
  `git fetch origin <sha>` if the clone is shallow) before assuming
  anything needs pushing — it's almost certainly a pre-reset leftover, not
  new work.
- Two long-dead branches on `practice_makes_perfect`
  (`claude/fantasy-manager-repo-am7b62`, safe to delete — identical to
  `foosballmanager/main`; `add-canonical-patterns-docs`, unrelated 593-line
  doc commit, not mine to judge) are stuck because this session's git
  gateway 403s on `git push --delete`, and the GitHub MCP tools available
  have no delete-branch method. If you hit the same wall, tell the user
  rather than burning turns on it — it's a 10-second fix from the GitHub
  UI (`/branches`, trash icon).

## Verification posture (why the commit messages are long)

None of this was ever tested against live Yahoo — this environment's
egress proxy blocks `fantasysports.yahoo.com` outright, and Yahoo's own
API access is still pending approval (see below). Every commit message
explains specifically what *was* verified and how, because "should work
per the docs" wasn't good enough for code nobody could watch run against
the real site. The two techniques worth knowing about if you extend this:

- **Golden-master testing** (`extension/test/compare_with_python.js` +
  `scripts/simulate_draft.py`): the Python engine drafts a full mock draft
  for every team, guardrails included; the JS port replays the identical
  draft and every pick is diffed. This is how the JS engine port was
  verified correct — 640 picks across 4 configs, zero mismatches — and it
  regenerates fresh from Python on every CI run specifically so a future
  change to `autopilot.py` can't silently drift from the JS port while
  CI stays green against a stale fixture.
- **Real browser verification**: this container has a bundled Chromium
  (`/opt/pw-browsers/`). The extension was actually loaded unpacked into it
  via Playwright and driven end-to-end — not just "the files exist and
  parse." That's how a real bug got caught (a content script's static
  `import` throws in Chrome even with a `"type": "module"` manifest hint;
  the fix is dynamic `import()`) that reading MV3 docs alone wouldn't have
  surfaced, since `developer.chrome.com` was also unreachable from here.

If you add a browser-facing feature, use this pattern: don't trust "should
work," load it into the real bundled Chromium and watch it run.

## What needs a human (can't be resolved from a coding session)

1. **League settings beyond the roster construction.** `num_teams` and
   `scoring` in `profiles/<name>/league.yaml` are still the generic
   defaults (10 teams, PPR). Only the starter slots are confirmed. Every
   tier and replacement-level number the engine produces reads from this
   file — get the real values in before draft day.
2. **Yahoo API application status.** Was "submitted," last known state.
   `yahoo_client.py` is written and unit-tested against Yahoo's documented
   response shapes but has never run against a live account. Once
   approved: two separate steps, registering the app AND applying for
   Fantasy API access specifically — people miss the second one. Redirect
   URI must be `https://localhost:8000` (Yahoo's older `oob` flow isn't
   reliably accepted for new apps anymore).
3. **A real dry run before draft day.** Both `browser_sync.py watch` (CLI)
   and the extension's content script need `--mode`/mode-select set
   correctly for the real draft room's layout (picks appearing vs. names
   disappearing from a pool) — this can only be confirmed against the
   actual Yahoo draft room, which no session has been able to reach. Try
   it against a mock draft. If nothing gets detected either way, capture
   the page (`browser_sync.py dump`, or the extension's panel log) and
   hand it to whoever's driving next — that one round trip fixes it. Same
   mock draft is also the place to test **auto-draft** (leave "fully
   automatic" off first) and, in Options, add whatever your room's real
   "your turn" wording is if `turnDetect.js`'s guessed phrases don't fire.
4. **Repo visibility.** Was flagged as worth making private earlier in
   this project's life (it's public; contains the user's actual research
   notes and trade strategy, harmless to have written but not necessarily
   meant for leaguemates to read before draft day) — never confirmed
   either way. Check `https://github.com/danbrown1337/foosballmanager/settings`.
5. **The two stale `practice_makes_perfect` branches** mentioned above.

## What's genuinely solid

- **246 Python tests, 49 JS unit tests, a 640-pick golden-master
  comparison** — all green, every push (counts re-verified directly via
  `python3 -m pytest` / `node --test`, not carried forward from an older
  commit message). `tests/test_data.py`
  checks the shipped CSVs, not just the code, so a bad player-name typo in
  `data/player_notes_2026.csv` fails CI instead of silently miscounting a
  trade offer.
- **Two real engine bugs found and fixed by testing, not inspection**:
  the roster-completion guardrail was counting the IR slot as a draftable
  pick (delayed the "must fill this starter slot" override past the actual
  final pick); a league with zero kicker slots could still have a kicker
  drafted onto the bench once skill-position value ran dry, because absent
  positions defaulted to "assume 1 starter" instead of "never draft this."
  Both reproduced directly before fixing, both have regression tests that
  fail against the old code.
- **The automation boundary, updated.** Roster moves and trades are still
  never automated anywhere in this project — that line hasn't moved.
  Drafting is now the one deliberate exception: the extension has an
  opt-in, off-by-default auto-draft (`src/lib/turnDetect.js` +
  `src/lib/domActions.js`, wired into `src/content/overlay.js`) that finds
  and clicks the recommended player when a configurable "your turn" phrase
  appears in the page text, then stops short of Yahoo's own confirm click
  unless a second "fully automatic" toggle is also on. This was added
  because the user explicitly asked for it ("But it needs too that's what
  we want"), not a refactor's side effect — CLI, web app, and browser sync
  are untouched, and trades/roster moves in the extension are untouched
  too. **Never verified against live Yahoo** (same limit as everything
  else — see "Verification posture"); `test/domActions.check.js` verifies
  the click-targeting logic against a real browser on a synthetic page, and
  the default "your turn" phrases in `turnDetect.js` are an educated guess.
  Test it in a Yahoo mock draft, "fully automatic" off, before trusting it
  live.
- **Two-person support** (`--profile`, or a separate Chrome profile for
  the extension) is real and tested — verified end-to-end that two
  people drafting side by side never see each other's picks and each gets
  recommended what the other just took.

## Architecture map

```
fantasy_manager/       CLI + web app (Python, stdlib + PyYAML only)
  board.py             ADP loading, tiering, replacement level
  autopilot.py         the pick engine — 4 guardrails, ported faithfully to JS
  profiles.py          per-person settings/rosters/state (chrome.storage.local
                        equivalent for the extension is src/lib/storage.js)
  browser_sync.py      Playwright-driven roster import + live draft watch
  web.py                point-and-click app, binds 127.0.0.1 (or --share)
config/league.yaml      TEMPLATE new profiles seed from — not read directly
profiles/<name>/        gitignored; real per-person data lives here
data/                   shared 2026 ADP + research notes (CSV)
extension/               Chrome extension, zero npm deps, load-unpacked
  src/engine/            board.js / autopilot.js / tradeTargeter.js —
                         faithful ports, verified via golden-master
  src/content/overlay.js the only piece that touches a live Yahoo page
  test/                  node:test + golden-master comparison tooling
scripts/                 CSV->JSON conversion + draft-simulation tooling
                         shared between the Python tests and the JS port
```

## If you're a Claude session with no memory of this conversation

Read `README.md` and `extension/README.md` first — they're the accurate,
current user-facing docs. This file exists because a lot of *why* decisions
were made (the automation boundary, the platform constraint that a Chrome
extension can't reach a native app, the shallow-clone/wrong-repo trap) live
only in a very long conversation history that won't be available to you.
If something in the code looks unusually cautious or over-verified, it's
probably because it was — read the commit message before assuming it's
excessive.
