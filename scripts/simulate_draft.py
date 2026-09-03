#!/usr/bin/env python3
"""
Runs a full mock draft with auto_pick() drafting for EVERY team, tracking
each team's own roster separately, then dumps the exact pick sequence to
JSON.

This is the Python half of a golden-master test: extension/test/compare_with_python.js
runs the identical simulation through the ported JS engine and diffs the two
outputs. A full draft exercises real tiering, every guardrail (K/DEF block,
bench cap, roster completion, replacement cliff), and notes-driven scoring —
far stronger evidence a port is correct than eyeballing the code.

auto_pick() only knows two states per player: "mine" (the picking team's own
roster) and anything else ("rival", i.e. taken by someone). To let every
team's own guardrails engage correctly turn by turn, drafted_by is
re-tagged before each pick: this team's own prior picks become "mine",
everyone else's stay "rival", so the guardrails see this team's real roster
composition rather than a single shared pool.

Run from the repo root:
    python3 scripts/simulate_draft.py > extension/test/golden_draft.json
"""
from __future__ import annotations

import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from fantasy_manager.autopilot import auto_pick
from fantasy_manager.board import build_board


def simulate(config_path: str | None) -> list[dict]:
    players, config = build_board(config_path)
    by_name = {p.name: p for p in players}

    num_teams = config["league"]["num_teams"]
    starters = config["roster"]["starters"]
    bench = config["roster"].get("bench", 0)
    total_spots = sum(starters.values()) + bench
    total_picks = num_teams * total_spots

    # Which team drafted which player name, in order.
    team_rosters: list[list[str]] = [[] for _ in range(num_teams)]
    picks = []

    for i in range(total_picks):
        team = i % num_teams

        # Re-tag every player from this team's perspective before asking
        # the engine to decide: their own picks are "mine", everyone else
        # who's been drafted (by any team) is "rival".
        mine_names = set(team_rosters[team])
        for p in players:
            if p.name in mine_names:
                p.drafted_by = "mine"
            elif any(p.name in roster for roster in team_rosters):
                p.drafted_by = "rival"
            else:
                p.drafted_by = None

        decision = auto_pick(players, config)
        if decision is None:
            break

        team_rosters[team].append(decision.player.name)
        picks.append({
            "pickNo": i + 1,
            "team": team,
            "player": decision.player.name,
            "pos": decision.player.pos,
            "reason": decision.reason,
            "needOverride": decision.need_override,
        })

    return picks


def main():
    config_path = sys.argv[1] if len(sys.argv) > 1 else None
    from fantasy_manager.board import load_config

    picks = simulate(config_path)
    # The resolved config rides alongside the picks so the JS comparison
    # test uses the literal values Python actually drafted against, rather
    # than needing its own YAML parser (a second parser is one more place
    # a port could subtly diverge, for something that isn't shipped in the
    # extension at all — the options page never parses YAML at runtime).
    json.dump({"config": load_config(config_path), "picks": picks}, sys.stdout, indent=2)


if __name__ == "__main__":
    main()
