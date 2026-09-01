#!/usr/bin/env python3
"""
Post-draft weekly roster manager.

Right now this runs on two hand-maintained CSVs (my_roster.csv and, for
the waiver-target view, the ADP board) because Yahoo API access is still
pending approval. Once fantasy_manager/yahoo_client.py has real
credentials, point load_my_roster() at yahoo_client.get_roster() instead
and everything downstream (bye-week checks, depth summary, waiver
targets) keeps working unchanged.

Usage:
  python3 -m fantasy_manager.roster_manager summary
  python3 -m fantasy_manager.roster_manager byeweeks
  python3 -m fantasy_manager.roster_manager waivers --pos WR --top 10
"""
from __future__ import annotations

import argparse
import csv
import os
from collections import defaultdict

from fantasy_manager import profiles
from fantasy_manager.board import POS_ALIASES, apply_draft_state, build_board
from fantasy_manager.bye_weeks import BYE_WEEKS



def load_my_roster(path: str | None = None) -> list[dict]:
    if path is None:
        profiles.ensure_profile()
        path = profiles.my_roster_path()
    if not os.path.exists(path):
        return []
    with open(path) as f:
        rows = list(csv.DictReader(f))
    for r in rows:
        r["pos"] = POS_ALIASES.get(r["pos"], r["pos"])
    return rows


def cmd_summary(args):
    roster = load_my_roster()
    if not roster:
        print(f"No roster on file yet — fill in {profiles.my_roster_path()} (name,pos,team) after your draft.")
        return
    by_pos = defaultdict(list)
    for r in roster:
        by_pos[r["pos"]].append(r)

    print(f"Roster ({len(roster)} players):")
    for pos in ["QB", "RB", "WR", "TE", "K", "DEF"]:
        players = by_pos.get(pos, [])
        names = ", ".join(f"{p['name']} ({p['team']})" for p in players) or "—"
        print(f"  {pos:<4} [{len(players)}] {names}")


def cmd_byeweeks(args):
    roster = load_my_roster()
    if not roster:
        print(f"No roster on file yet — fill in {profiles.my_roster_path()} first.")
        return

    by_week = defaultdict(list)
    for r in roster:
        week = BYE_WEEKS.get(r["team"])
        if week:
            by_week[week].append(r)

    print("Bye-week conflicts (2+ starters-worthy players out the same week):")
    flagged = False
    for week in sorted(by_week):
        players = by_week[week]
        pos_count = defaultdict(int)
        for p in players:
            pos_count[p["pos"]] += 1
        crowded = {pos: n for pos, n in pos_count.items() if n >= 2}
        if crowded:
            flagged = True
            names = ", ".join(f"{p['name']} ({p['pos']})" for p in players)
            print(f"  Week {week}: {names}")
    if not flagged:
        print("  None — your bye weeks are well spread out.")


def cmd_waivers(args):
    """Best remaining players by ADP not on your roster — a reasonable proxy
    for waiver-wire priority until live Yahoo transactions data is wired in."""
    players, config = build_board()
    mine = {r["name"] for r in load_my_roster()}

    avail = [p for p in players if p.name not in mine]
    if args.pos:
        avail = [p for p in avail if p.pos == args.pos.upper()]
    avail.sort(key=lambda p: p.adp)

    print(f"{'PLAYER':<26}{'POS':<5}{'TEAM':<6}{'ADP':<8}TIER")
    for p in avail[: args.top]:
        print(f"{p.name:<26}{p.pos:<5}{p.team:<6}{p.adp:<8}{p.tier}")


def cmd_overachievers(args):
    """
    Players analysts expect to outperform their draft price — i.e. beating
    expectation relative to where they were picked, not any trait of the
    player besides on-field performance and opportunity.

    Pre-season this reads off the researched breakout calls in
    data/player_notes_2026.csv (see each player's `note` for the reasoning:
    new role, efficiency edge, depth-chart opening, etc). Once real weekly
    stats exist post-kickoff, extend this to compare actual points-per-game
    against the positional average for a player's draft tier — the
    plumbing (adjusted_adp, tiers) is already here, it just needs a
    weekly stats CSV to compare against.
    """
    players, config = build_board()
    apply_draft_state(players)

    overachieving = [p for p in players if p.note_tag == "breakout"]
    if args.pos:
        overachieving = [p for p in overachieving if p.pos == args.pos.upper()]
    overachieving.sort(key=lambda p: p.adjustment)  # most negative = biggest expected beat

    if not overachieving:
        print("No breakout-tagged players match that filter.")
        return

    print(f"{'PLAYER':<24}{'POS':<5}{'TEAM':<6}{'ADP':<8}{'ADJ.ADP':<9}{'STATUS':<10}NOTE")
    for p in overachieving[: args.top]:
        status = p.drafted_by or "available"
        print(f"{p.name:<24}{p.pos:<5}{p.team:<6}{p.adp:<8}{p.adjusted_adp:<9.1f}{status:<10}{p.note}")


def main():
    parser = argparse.ArgumentParser(description="Weekly roster manager")
    parser.add_argument("--profile", default=None,
                        help="Which person's setup to use (default: the FANTASY_PROFILE env var, else 'default'). Each profile has its own league settings, rosters and draft state.")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_sum = sub.add_parser("summary", help="Roster breakdown by position")
    p_sum.set_defaults(func=cmd_summary)

    p_bye = sub.add_parser("byeweeks", help="Flag bye-week pileups")
    p_bye.set_defaults(func=cmd_byeweeks)

    p_wai = sub.add_parser("waivers", help="Best available players not on your roster")
    p_wai.add_argument("--pos", default=None)
    p_wai.add_argument("--top", type=int, default=15)
    p_wai.set_defaults(func=cmd_waivers)

    p_over = sub.add_parser("overachievers", help="Players expected to beat their draft price")
    p_over.add_argument("--pos", default=None)
    p_over.add_argument("--top", type=int, default=15)
    p_over.set_defaults(func=cmd_overachievers)

    args = parser.parse_args()
    profiles.set_active_profile(args.profile)
    args.func(args)


if __name__ == "__main__":
    main()
