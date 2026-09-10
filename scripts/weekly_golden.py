#!/usr/bin/env python3
"""
Generate the weekly-engine golden master: what fantasy_manager/weekly.py
decides, for a spread of rosters and league shapes, as JSON.

extension/test/compare_weekly_with_python.js replays every case through the
ported JS engine and diffs each field. That diff is the evidence the port is
correct — reading the two implementations side by side is not, and the draft
port already demonstrated that a plausible-looking translation can disagree
with Python in ways only a comparison catches.

The fixture carries the parsed roster rows AND the league config Python used,
so the JS side needs no parser and no YAML reader of its own.

Regenerate whenever weekly.py changes:
  python3 scripts/weekly_golden.py > extension/test/weekly_golden.json
"""
from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fantasy_manager.browser_sync import parse_weekly_text          # noqa: E402
from fantasy_manager.bye_weeks import BYE_WEEKS                     # noqa: E402
from fantasy_manager.weekly import (                                # noqa: E402
    WeeklyPlayer,
    bye_outlook,
    evaluate_waiver_targets,
    lineup_changes,
    optimal_lineup,
)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FIXTURES = os.path.join(ROOT, "tests", "fixtures")

# The league shapes worth pinning: the one this project was built for (two
# flex, no kicker), a conventional kicker league, and a superflex — which is
# the configuration where slot fill order actually changes the answer.
LEAGUES = {
    "two_flex_no_kicker": {"QB": 1, "RB": 2, "WR": 2, "TE": 1, "FLEX": 2, "DEF": 1},
    "kicker_one_flex": {"QB": 1, "RB": 2, "WR": 2, "TE": 1, "FLEX": 1, "K": 1, "DEF": 1},
    "superflex": {"QB": 1, "RB": 2, "WR": 2, "TE": 1, "FLEX": 1, "DEF": 1},
    "thin_roster": {"QB": 1, "RB": 2, "WR": 2, "TE": 1, "FLEX": 2, "K": 1, "DEF": 1},
}


def load_roster(filename: str) -> list[WeeklyPlayer]:
    with open(os.path.join(FIXTURES, filename)) as f:
        return [WeeklyPlayer(**row) for row in parse_weekly_text(f.read())]


def as_row(player: WeeklyPlayer | None) -> dict | None:
    """A player as the JS engine expects one: plain object, camelCase byeWeek."""
    if player is None:
        return None
    return {
        "name": player.name, "pos": player.pos, "team": player.team,
        "slot": player.slot, "status": player.status, "opponent": player.opponent,
        "proj": player.proj, "bye": player.bye, "byeWeek": player.bye_week,
    }


def lineup_case(label, roster, starters, superflex=False, allow_doubtful=False):
    best = optimal_lineup(roster, starters, superflex=superflex,
                          allow_doubtful=allow_doubtful)
    changes = lineup_changes(roster, best)
    return {
        "label": label,
        "roster": [as_row(p) for p in roster],
        "starters": starters,
        "superflex": superflex,
        "allowDoubtful": allow_doubtful,
        "expected": {
            "slots": [
                {"slot": a.slot,
                 "player": a.player.name if a.player else None,
                 "emptyReason": a.empty_reason}
                for a in best.starters
            ],
            "bench": [p.name for p in best.bench],
            "projected": round(best.projected, 2),
            "warnings": best.warnings,
            "changes": [
                {"slot": c.slot,
                 "start": c.start_player.name if c.start_player else None,
                 "bench": c.bench_player.name if c.bench_player else None,
                 "gain": c.gain,
                 "reason": c.reason,
                 "moveOnly": c.move_only}
                for c in changes
            ],
        },
    }


def waiver_case(label, roster, available, starters, faab_remaining=None, top=6):
    targets = evaluate_waiver_targets(
        available, roster, starters, faab_remaining=faab_remaining, top=top)
    return {
        "label": label,
        "roster": [as_row(p) for p in roster],
        "available": [as_row(p) for p in available],
        "starters": starters,
        "faabRemaining": faab_remaining,
        "top": top,
        "expected": [
            {"name": t.player.name,
             "gain": t.gain,
             "replaces": t.replaces.name if t.replaces else None,
             "drop": t.drop.name if t.drop else None,
             "rationale": t.rationale,
             "bidLow": t.bid_low,
             "bidHigh": t.bid_high,
             "worthPriority": t.worth_priority,
             "note": t.note}
            for t in targets
        ],
    }


def bye_case(label, roster, week, starters, weeks_ahead=3):
    return {
        "label": label,
        "roster": [as_row(p) for p in roster],
        "week": week,
        "starters": starters,
        "weeksAhead": weeks_ahead,
        "byeWeeks": BYE_WEEKS,
        "expected": [
            {"week": target, "players": [p.name for p in players]}
            for target, players in bye_outlook(roster, BYE_WEEKS, week, starters,
                                               weeks_ahead=weeks_ahead)
        ],
    }


def main() -> None:
    week1 = load_roster("yahoo_myteam_week1.txt")
    week5 = load_roster("yahoo_myteam_week5_kicker.txt")

    lineups = [
        lineup_case("week1 / two flex, no kicker", week1, LEAGUES["two_flex_no_kicker"]),
        lineup_case("week1 / kicker league (no K on roster: empty slot)",
                    week1, LEAGUES["kicker_one_flex"]),
        lineup_case("week1 / superflex", week1, LEAGUES["superflex"], superflex=True),
        lineup_case("week5 / kicker league", week5, LEAGUES["kicker_one_flex"]),
        lineup_case("week5 / no kicker slot, so no kicker started",
                    week5, LEAGUES["two_flex_no_kicker"]),
        lineup_case("week5 / doubtful admitted", week5, LEAGUES["kicker_one_flex"],
                    allow_doubtful=True),
        lineup_case("week5 / more slots than players", week5, LEAGUES["thin_roster"]),
        lineup_case("empty roster", [], LEAGUES["two_flex_no_kicker"]),
    ]

    wire = [
        WeeklyPlayer(name="Jordan Mason", pos="RB", team="MIN", proj=14.9),
        WeeklyPlayer(name="Travis Kelce", pos="TE", team="KC", proj=11.7),
        WeeklyPlayer(name="Cam Little", pos="K", team="JAX", proj=9.1),
        WeeklyPlayer(name="Tyler Allgeier", pos="RB", team="ATL", proj=8.2),
        WeeklyPlayer(name="Cedric Tillman", pos="WR", team="CLE", proj=7.4, status="Q"),
        WeeklyPlayer(name="Injured Guy", pos="WR", team="NYJ", proj=18.0, status="IR"),
        WeeklyPlayer(name="Unknown Rookie", pos="RB", team="SF", proj=None),
    ]

    waivers = [
        waiver_case("week1 wire, $100 FAAB", week1, wire,
                    LEAGUES["two_flex_no_kicker"], faab_remaining=100),
        waiver_case("week1 wire, $12 FAAB left", week1, wire,
                    LEAGUES["two_flex_no_kicker"], faab_remaining=12),
        waiver_case("week1 wire, priority league (no budget)", week1, wire,
                    LEAGUES["two_flex_no_kicker"], faab_remaining=None),
        waiver_case("kicker league with an empty K slot", week1, wire,
                    LEAGUES["kicker_one_flex"], faab_remaining=100),
        waiver_case("week5 wire", week5, wire,
                    LEAGUES["kicker_one_flex"], faab_remaining=50),
    ]

    byes = [
        bye_case("week5 roster, looking 3 weeks out", week5, 5,
                 LEAGUES["kicker_one_flex"]),
        bye_case("week1 roster, looking 6 weeks out", week1, 1,
                 LEAGUES["two_flex_no_kicker"], weeks_ahead=6),
        bye_case("no current week", week5, None, LEAGUES["kicker_one_flex"]),
    ]

    json.dump({"lineups": lineups, "waivers": waivers, "byes": byes},
              sys.stdout, indent=1, sort_keys=False)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
