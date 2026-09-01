# Fantasy Manager

Personal Yahoo Fantasy Football draft + weekly management tool.

## Status

- **League settings**: 10 teams, Full PPR, standard 1-QB confirmed. Roster
  construction in `config/league.yaml` is a best-guess Yahoo default —
  edit it once the real league exists.
- **Yahoo API**: access application submitted; it's read-only even once
  approved, so trades can never be auto-submitted — see `trade_targeter.py`.
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

## Yahoo API (once approved)

```
python3 -m fantasy_manager.yahoo_client init         # write credentials template
# fill in config/yahoo_credentials.json with your Client ID/Secret
python3 -m fantasy_manager.yahoo_client authorize    # one-time OAuth login
python3 -m fantasy_manager.yahoo_client leagues       # sanity check
python3 -m fantasy_manager.yahoo_client sync-rosters --league-key <key>
```
