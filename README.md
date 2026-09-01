# Fantasy Manager

[![tests](https://github.com/danbrown1337/foosballmanager/actions/workflows/ci.yml/badge.svg)](https://github.com/danbrown1337/foosballmanager/actions/workflows/ci.yml)

Personal Yahoo Fantasy Football draft + weekly management tool.

## Status

- **League settings**: 10 teams, Full PPR, standard 1-QB confirmed. Roster
  construction in `config/league.yaml` is a best-guess Yahoo default —
  edit it once the real league exists.
- **Yahoo API**: access application submitted; it's read-only even once
  approved, so trades can never be auto-submitted — see `trade_targeter.py`.
  The client is written and unit-tested against Yahoo's documented response
  shapes, but has not been run against a live account — that needs an
  approved Client ID. See the Yahoo API section below.
- **Draft data**: `data/adp_2026_ppr.csv` holds live 2026 PPR mock-draft
  ADP (top 190 players) pulled just before the season. Swap in real
  point projections later by adding a `proj_pts` column — `board.py` is
  built to prefer that once it exists.
- **Autopilot**: `data/player_notes_2026.csv` layers researched bust/injury/
  breakout calls (sourced from beat-writer and analyst coverage, see the
  `note` column for the reasoning per player) on top of ADP. `config/league.yaml`'s
  `autopilot:` block is set to Dan's chosen strategy (best player available,
  balanced risk) — `fantasy_manager/autopilot.py` is the decision engine,
  exposed via `draft_assistant.py autopick`.

## Setup

```
pip install -r requirements.txt --break-system-packages
```

Run every command from the project root — `config/` and `data/` are
resolved relative to it. To get the shorter console scripts
(`draft-assistant board` instead of `python3 -m ...`), install editable:

```
pip install -e . --break-system-packages
```

Editable specifically: a regular install would move the package into
site-packages, away from the CSVs it reads.

## Draft day

```
python3 -m fantasy_manager.draft_assistant board                       # best available
python3 -m fantasy_manager.draft_assistant pick "Player Name" --by mine
python3 -m fantasy_manager.draft_assistant pick "Player Name" --by rival
python3 -m fantasy_manager.draft_assistant recommend                   # what to take next + scarcity
python3 -m fantasy_manager.draft_assistant autopick                    # full-autopilot: one decision + reasoning
python3 -m fantasy_manager.draft_assistant autopick --commit           # ...and mark it drafted by you
python3 -m fantasy_manager.draft_assistant myteam
python3 -m fantasy_manager.draft_assistant reset                       # clear state, start over
```

Run one command per pick as the live draft happens. State lives in
`draft_state.json` so you can close and reopen the terminal mid-draft.

## After the draft

```
python3 -m fantasy_manager.roster_manager summary     # roster by position
python3 -m fantasy_manager.roster_manager byeweeks     # bye-week pileups
python3 -m fantasy_manager.roster_manager waivers --pos RB --top 10
python3 -m fantasy_manager.roster_manager overachievers          # beating their draft price, by performance/opportunity
```

Fill in `my_roster.csv` by hand until Yahoo API access is approved, then
`yahoo_client.py sync-rosters` can populate it automatically.

## Lowball trades

```
python3 -m fantasy_manager.trade_targeter list-teams
python3 -m fantasy_manager.trade_targeter offers --team "Rival Team Name"
python3 -m fantasy_manager.trade_targeter offers --all --count 2
```

Fill in `league_rosters.csv` (every team's roster) and add rival names
under `rivals:` in `config/league.yaml`. Offers print to the terminal —
you send them yourself in the Yahoo app. Sending is intentionally manual;
Yahoo's API can't submit trades, and scripting the actual sends risks
looking like bot activity against Yahoo's terms.

## Yahoo API

Yahoo gates Fantasy Sports API access behind an application review, and it is
**read-only** even once granted — no trades, adds, or drops can be submitted
through it. Two separate steps are needed before any of this works:

1. Register an app at developer.yahoo.com to get a Client ID and Secret.
   Set its **Redirect URI to `https://localhost:8000`** — Yahoo wants an
   HTTPS redirect; the older `oob` (code-on-screen) flow is no longer
   reliably accepted. Nothing needs to listen on that port.
2. Apply for Fantasy Sports API access at sports.yahoo.com/developer/access/
   and associate the approval with that Client ID. Registering the app alone
   is not enough.

Then:

```
python3 -m fantasy_manager.yahoo_client init         # write credentials template
# fill in config/yahoo_credentials.json: Client ID, Secret, redirect_uri
python3 -m fantasy_manager.yahoo_client authorize    # one-time OAuth login
python3 -m fantasy_manager.yahoo_client leagues      # sanity check — find your league_key
python3 -m fantasy_manager.yahoo_client sync-rosters --league-key 449.l.123456
```

`authorize` prints a Yahoo URL. Approving it redirects the browser to
`https://localhost:8000`, which shows an error page — that is expected, since
nothing is serving it. Copy the **whole URL** out of the address bar and paste
it in; the authorization code is in the query string and gets extracted for
you. Tokens are saved to `yahoo_tokens.json` (mode 0600) and refreshed
automatically after that.

If your own team isn't detected during a sync, pass it explicitly:

```
python3 -m fantasy_manager.yahoo_client sync-rosters \
    --league-key 449.l.123456 --my-team-key 449.l.123456.t.4
```

`sync-rosters` writes `league_rosters.csv` and `my_roster.csv`, then reports
any synced player whose name doesn't match the ADP board. Those players have
no value attached, so they're invisible to the trade generator and the waiver
view — deep bench players are expected, but a starter in that list means the
spelling differs and is worth aliasing.

## Importing rosters from the browser (while API access is pending)

Yahoo's API needs an approved application. Until that lands, `browser_sync.py`
reads the same rosters off the league pages you're already looking at, so they
don't have to be typed in by hand.

It never sees your password: it attaches over the DevTools protocol to a Chrome
**you** started and logged into.

```
pip install playwright --break-system-packages     # no browser download needed

# Quit Chrome completely, then relaunch with debugging enabled:
#   macOS:   /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222
#   Linux:   google-chrome --remote-debugging-port=9222
#   Windows: chrome.exe --remote-debugging-port=9222
# Log into Yahoo Fantasy in that window, then:

python3 -m fantasy_manager.browser_sync sync --url <your league rosters URL>
python3 -m fantasy_manager.browser_sync sync --url <your team URL> --mine
```

An already-running Chrome can't be attached to — it has to be restarted with
the flag.

If parsing comes up empty, save the page and we can fix the parser against what
Yahoo actually renders:

```
python3 -m fantasy_manager.browser_sync dump --url <url> --out page.html
python3 -m fantasy_manager.browser_sync parse --from-file page.html
```

`parse` also takes plain text, so copying the roster out of the page by hand
works with no automation at all:

```
python3 -m fantasy_manager.browser_sync parse --from-text roster.txt --mine
```

Parsing keys off Yahoo's rendered `Name TEAM - POS` text rather than CSS
selectors, which are generated and change without notice. Names keep their
punctuation (`Marvin Harrison Jr.`, `A.J. Brown`) because matching the ADP
board exactly is what attaches a player's value — anything unmatched gets
reported rather than silently counting for nothing.

This is read-only by design. Nothing here submits trades, adds, or drops —
the same call `trade_targeter.py` already makes.

## Repository layout

```
fantasy_manager/       the package
  board.py             ADP loading, tiering, replacement level, draft state
  autopilot.py         the pick engine (scoring + four guardrails)
  draft_assistant.py   draft-day CLI
  roster_manager.py    post-draft weekly CLI
  trade_targeter.py    lowball offer generator
  yahoo_client.py      Yahoo OAuth2 + read endpoints
  browser_sync.py      roster import via your own logged-in Chrome
  bye_weeks.py         2026 bye weeks by team
config/league.yaml     league settings — everything downstream reads from here
data/                  2026 ADP board + researched player notes
tests/                 pytest suite
```

## Development

```
pip install -e ".[dev]" --break-system-packages
python -m pytest
```

Use `python -m pytest` rather than bare `pytest` so the repo root is on
`sys.path` and `import fantasy_manager` resolves without an install.

The suite covers the tiering and replacement-level math, all four autopilot
guardrails, the trade generator's valuation, and the documented CLI commands
end-to-end (as subprocesses against a throwaway copy of the project, so draft
state never touches your working tree).

`tests/test_data.py` checks the shipped CSVs rather than the code — player
names in `data/player_notes_2026.csv` matching the ADP board, every drafted
team having a bye week, ADP ordering, valid tags. Those failures are the ones
that would otherwise degrade the tool silently on draft night.

CI runs the suite on Python 3.10 through 3.13.
