# Sharing this with a friend

This repo is a personal Yahoo Fantasy Football tool: a draft assistant
(live tiers + a full-autopilot pick engine), a weekly roster manager, and
a lowball-trade generator. It was built for one specific league (10-team,
full PPR, standard 1-QB) — nothing about it is hardcoded to *whose*
league, so anyone can point it at their own.

There are two ways to make it yours. Pick whichever matches how you like
to work.

## Path A — run it yourself

1. Clone the repo and install the one dependency:
   ```
   git clone <repo-url>
   cd fantasy_manager
   pip install -r requirements.txt --break-system-packages
   ```
2. Make yourself a profile and edit it:
   ```
   python3 -m fantasy_manager.profiles new <your-name>
   ```
   That creates `profiles/<your-name>/league.yaml`. Change `num_teams`,
   `scoring`, and `roster.starters`/`bench`/`ir` to match your actual
   league, and add rival managers under `rivals:` if you want the trade
   generator pointed at them. Then put `--profile <your-name>` on any
   command. (`config/league.yaml` is only the template new profiles are
   copied from — editing it changes nothing that's already set up.)

   Profiles also mean you and the person who sent you this can share one
   checkout without colliding, if you ever want to.
3. `data/adp_2026_ppr.csv` and `data/player_notes_2026.csv` are
   league-agnostic (they're general 2026 NFL draft rankings and
   researched risk/breakout notes, not specific to any one league) — you
   can use them as-is. They'll go stale as the season moves on, so treat
   them as a snapshot from just before kickoff, not a live feed.
4. Everything else works the same way it does for the original league —
   see `README.md` for the full command list (`draft_assistant.py`,
   `roster_manager.py`, `trade_targeter.py`).
5. If you want live Yahoo sync instead of hand-filled CSVs: Yahoo gates
   Fantasy Sports API access behind an application now (it's read-only,
   and it's per-developer — you can't reuse someone else's approval).
   Apply at sports.yahoo.com/developer/access/, then follow the
   `yahoo_client.py` instructions in `README.md` once you're approved.

## Path B — hand it to your own Claude

If you'd rather talk your way through the setup than edit YAML by hand:

1. Download this repo (as a zip, or `git clone` it) onto whatever machine
   or Claude session you're using.
2. Open a new Claude conversation (Claude Code, Cowork, or claude.ai with
   the folder/zip attached) and say something like:

   > "This is a personal Yahoo Fantasy Football draft/roster tool a
   > friend built for his own league. Read through it, then help me
   > adapt `config/league.yaml` to my league's settings and get my own
   > Yahoo Fantasy Sports API access set up so it can pull my real
   > rosters."

3. Claude can read `README.md` and the code directly, ask you for your
   league's scoring/roster settings the same way this one did, and walk
   you through Yahoo's application process (same gated flow described
   above — it'll need your own Client ID/Secret once approved, not this
   league's).
4. Everything under `profiles/` — league settings, rosters, Yahoo
   credentials and tokens — is gitignored in full, so nothing sensitive
   carries over from this copy and nothing of yours can be committed by
   accident. You're starting clean.

## What's actually yours vs. reusable

- **Reusable as-is:** the ADP rankings, the researched player notes, the
  tiering/scarcity engine, the autopilot decision logic, the roster and
  trade-offer tooling.
- **Needs changing:** `config/league.yaml` (your league's actual
  settings), `my_roster.csv` / `league_rosters.csv` (empty templates —
  fill in after your own draft), and your own Yahoo API credentials if
  you want live sync.
