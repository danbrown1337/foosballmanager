# Fantasy Manager

[![tests](https://github.com/danbrown1337/foosballmanager/actions/workflows/ci.yml/badge.svg)](https://github.com/danbrown1337/foosballmanager/actions/workflows/ci.yml)

A Yahoo Fantasy Football draft assistant and in-season roster manager.

It tiers the player pool, tracks who's gone as the draft happens, and tells you
who to take next — with the reasoning, and with guardrails so "best player
available" never leaves you short a starter. After the draft it handles roster
checks, bye-week pileups and trade offers.

## Start here

```bash
git clone https://github.com/danbrown1337/foosballmanager
cd foosballmanager
pip install -r requirements.txt --break-system-packages
python3 -m fantasy_manager.web
```

That last command opens a browser on the draft board. Click **Taken** when
someone else drafts a player, **Mine** when you do; the panel at the top always
shows what to take next and why. No terminal knowledge needed beyond starting
it, and it uses only what Python ships with, so there's nothing else to install.

The app serves on `127.0.0.1` — your machine only, not the network.

Everything below is optional.

## Two people, one checkout

Each person gets a **profile**: their own league settings, rosters and draft
state, side by side and never colliding.

```bash
python3 -m fantasy_manager.profiles new alex
python3 -m fantasy_manager.profiles list
```

Then put `--profile alex` on any command:

```bash
python3 -m fantasy_manager.web --profile alex
python3 -m fantasy_manager.draft_assistant --profile alex board
```

`FANTASY_PROFILE=alex` does the same thing if you'd rather not repeat the flag.
With no profile given, everything uses `default`, so a single user never has to
think about this.

A new profile is seeded from `config/league.yaml`. **Edit your own copy** at
`profiles/<name>/league.yaml` — team count, scoring and roster slots — before
you draft; every tier, replacement-level and autopilot decision reads from it.
The ADP board and research notes in `data/` are general 2026 rankings, so they
stay shared.

`profiles/` is gitignored in full. Nobody's league, roster or Yahoo credentials
can be committed.

### Sharing the board live

```bash
python3 -m fantasy_manager.web --share
```

Prints a link carrying an access key. Anyone you send it to, on the same
network, opens the same live board — useful for drafting with someone looking
over your shoulder from their own laptop.

Two things to know. **`--share` binds to your whole local network**, not just
your machine, so the key is what stops a passer-by editing your draft — send
the whole link, and don't post it anywhere public. And anyone with the link can
draft, undo and reset, so only share it with someone you'd hand the keyboard
to. Restart without `--share` to stop.

If the detected address is wrong, override it: `--share --share-host 192.168.1.42`.

## Draft day

The app covers all of this by clicking. The command line is here if you prefer it:

```bash
python3 -m fantasy_manager.draft_assistant board                    # best available
python3 -m fantasy_manager.draft_assistant pick "Player Name" --by rival
python3 -m fantasy_manager.draft_assistant autopick                 # one decision + reasoning
python3 -m fantasy_manager.draft_assistant autopick --commit        # ...and take it
python3 -m fantasy_manager.draft_assistant myteam
python3 -m fantasy_manager.draft_assistant reset
```

Names match fuzzily, so `"Jahmyr Gibs"` still lands. State persists between
commands — you can close the terminal mid-draft.

### Recording picks automatically

Typing in 144 rival picks on a 90-second clock is miserable, and a missed pick
silently corrupts the scarcity math the guardrails depend on. `watch` reads the
draft room in a Chrome you're already logged into and records picks as they
land:

```bash
pip install playwright --break-system-packages   # no browser download needed

# Quit Chrome fully, then relaunch it and log into Yahoo:
google-chrome --remote-debugging-port=9222
#   macOS:   /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222
#   Windows: chrome.exe --remote-debugging-port=9222

python3 -m fantasy_manager.browser_sync watch --url <draft room URL>
```

Picks are recorded as `rival`; mark your own in the app or with
`autopick --commit`, and `watch` merges rather than clobbering. It never
handles your password — it drives a session you opened.

`--mode` has to match your page: `appear` (default) for a picks feed or results
view, `disappear` for an available-player pool. The wrong one records nothing
rather than nonsense. **Try this against a mock draft before draft day**; if it
records nothing either way, `dump --url <url> --out page.html` saves the page so
the parser can be corrected.

## After the draft

```bash
python3 -m fantasy_manager.roster_manager summary        # roster by position
python3 -m fantasy_manager.roster_manager byeweeks       # bye-week pileups
python3 -m fantasy_manager.roster_manager waivers --pos RB --top 10
python3 -m fantasy_manager.roster_manager overachievers  # beating their draft price

python3 -m fantasy_manager.trade_targeter list-teams
python3 -m fantasy_manager.trade_targeter offers --all --count 2
```

These read your profile's `my_roster.csv` and `league_rosters.csv`. Fill them in
by hand, or import them from the browser:

```bash
python3 -m fantasy_manager.browser_sync sync --url <your team URL> --mine
python3 -m fantasy_manager.browser_sync sync --url <league rosters URL>
```

Trade offers print for you to send yourself. Nothing here submits a trade, add
or drop — Yahoo's API is read-only, and scripting real actions against a league
risks looking like bot activity.

## Yahoo API

Yahoo gates Fantasy Sports API access behind an application review, and it's
**read-only** even once granted. Two separate steps:

1. Register an app at developer.yahoo.com for a Client ID and Secret. Set its
   **Redirect URI to `https://localhost:8000`** — Yahoo wants an HTTPS
   redirect; the older `oob` flow is no longer reliably accepted. Nothing needs
   to listen on that port.
2. Apply at sports.yahoo.com/developer/access/ and associate the approval with
   that Client ID. Registering the app alone is not enough.

```bash
python3 -m fantasy_manager.yahoo_client init       # writes a credentials template
python3 -m fantasy_manager.yahoo_client authorize  # one-time OAuth login
python3 -m fantasy_manager.yahoo_client leagues    # find your league_key
python3 -m fantasy_manager.yahoo_client sync-rosters --league-key 449.l.123456
```

`authorize` prints a Yahoo URL. Approving redirects to `https://localhost:8000`,
which shows an error page — expected, nothing is serving it. Paste the **whole
URL** back in; the code is extracted from its query string. Tokens are saved to
your profile at mode 0600 and refreshed automatically.

Add `--my-team-key 449.l.123456.t.4` if your own team isn't detected.

## Repository layout

```
fantasy_manager/
  board.py             ADP loading, tiering, replacement level, draft state
  autopilot.py         the pick engine (scoring + four guardrails)
  draft_assistant.py   draft-day CLI
  web.py               point-and-click app (stdlib only)
  browser_sync.py      roster import + live draft watching via your Chrome
  roster_manager.py    post-draft weekly CLI
  trade_targeter.py    trade offer generator
  yahoo_client.py      Yahoo OAuth2 + read endpoints
  profiles.py          per-person settings, rosters and draft state
  bye_weeks.py         2026 bye weeks by team
config/league.yaml     template new profiles are seeded from
data/                  2026 ADP board + researched player notes (shared)
profiles/<name>/       your league settings, rosters, draft state (gitignored)
tests/                 pytest suite
```

## Development

```bash
pip install -e ".[dev]" --break-system-packages
python -m pytest
```

Use `python -m pytest` rather than bare `pytest` so the repo root is on
`sys.path`. CI runs the suite on Python 3.10 through 3.13.

The suite covers the tiering and replacement-level math, all four autopilot
guardrails, profile isolation, the trade generator's valuation, the web app's
HTTP surface and access-key gating, and the CLIs end to end. `tests/test_data.py`
checks the shipped CSVs rather than the code — the failures that would otherwise
only surface mid-draft.

## Current state

- **Draft data** is a snapshot: `data/adp_2026_ppr.csv` holds 2026 PPR
  mock-draft ADP for the top 190 players, pulled just before the season, and
  `data/player_notes_2026.csv` layers researched bust/injury/breakout calls on
  top. Both go stale as the season moves. Add a `proj_pts` column to the ADP
  file and `board.py` will prefer real projections over ADP automatically.
- **Yahoo API** access is pending approval. The client is written and
  unit-tested against Yahoo's documented response shapes but has not run
  against a live account. Until it's approved, use the browser import above.
- **`waivers` doesn't yet exclude players on rival rosters** — it filters only
  against your own, so treat it as a best-available list rather than a true
  waiver wire.
- **`overachievers` runs on pre-season research.** Comparing actual points
  against tier expectation needs a weekly stats file that doesn't exist yet;
  the tiering plumbing is already in place for it.
