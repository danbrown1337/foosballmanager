#!/usr/bin/env python3
"""
Lowball trade generator — the "annoy certain teams" tool.

Feeds off league_rosters.csv (team_name,manager,name,pos,team), which you
fill in by hand after the draft (or once Yahoo API access is approved,
yahoo_client.get_league_rosters() can write this file automatically).

The strategy: for each target team, find a position where they're
rostered deep (surplus, so losing one "doesn't hurt") and a position
where they're thin (deficit, so they might actually be tempted). The
offer sends them one of YOUR worst players at their thin spot in
exchange for one of THEIR best players at their deep spot — a
lopsided ask on purpose. This can't be sent through Yahoo's API
(read-only), so it prints ready-to-send offers for you to fire off
by hand.

Usage:
  python3 -m fantasy_manager.trade_targeter list-teams
  python3 -m fantasy_manager.trade_targeter offers --team "Team Name"
  python3 -m fantasy_manager.trade_targeter offers --all --count 2
"""
from __future__ import annotations

import argparse
import csv
import os
from collections import defaultdict

from fantasy_manager import profiles
from fantasy_manager.board import POS_ALIASES, load_config, load_players
from fantasy_manager.roster_manager import load_my_roster



def load_league_rosters(path: str | None = None) -> dict[str, list[dict]]:
    if path is None:
        profiles.ensure_profile()
        path = profiles.league_rosters_path()
    teams = defaultdict(list)
    if not os.path.exists(path):
        return teams
    with open(path) as f:
        for row in csv.DictReader(f):
            if not row.get("team_name"):
                continue
            row["pos"] = POS_ALIASES.get(row["pos"], row["pos"])
            teams[row["team_name"]].append(row)
    return teams


def adp_lookup() -> dict[str, "Player"]:
    return {p.name: p for p in load_players()}


def surplus_and_deficit(roster: list[dict], config: dict) -> tuple[list[str], list[str]]:
    starters = config["roster"]["starters"]
    counts = defaultdict(int)
    for p in roster:
        counts[p["pos"]] += 1

    surplus, deficit = [], []
    for pos in ["QB", "RB", "WR", "TE"]:
        need = starters.get(pos, 0) + (0.5 if pos in ("RB", "WR") else 0)  # flex fuzziness
        have = counts.get(pos, 0)
        if have >= need + 2:
            surplus.append(pos)
        elif have <= need:
            deficit.append(pos)
    return surplus, deficit


def cmd_list_teams(args):
    teams = load_league_rosters()
    if not teams:
        print(f"No rival roster data yet — fill in {profiles.league_rosters_path()} "
              f"(team_name,manager,name,pos,team) once the draft's done.")
        return
    for name, roster in teams.items():
        print(f"{name} ({len(roster)} players)")


def build_offers_for_team(team_name: str, roster: list[dict], my_roster: list[dict],
                           adp: dict, config: dict, count: int) -> list[str]:
    surplus, deficit = surplus_and_deficit(roster, config)
    offers = []

    if not surplus or not deficit:
        return offers

    # Their best player at each surplus position (lowest ADP = most valuable)
    best_by_pos = defaultdict(list)
    for p in roster:
        info = adp.get(p["name"])
        if info:
            best_by_pos[p["pos"]].append((info.adp, p["name"]))
    for pos in best_by_pos:
        best_by_pos[pos].sort()

    # Our worst player at each deficit position (highest ADP = least valuable)
    worst_mine_by_pos = defaultdict(list)
    for p in my_roster:
        info = adp.get(p["name"])
        if info:
            worst_mine_by_pos[p["pos"]].append((info.adp, p["name"]))
    for pos in worst_mine_by_pos:
        worst_mine_by_pos[pos].sort(reverse=True)

    n = 0
    for want_pos in surplus:
        if want_pos not in best_by_pos:
            continue
        for give_pos in deficit:
            candidates = worst_mine_by_pos.get(give_pos, [])
            if not candidates:
                continue
            target_adp, target_name = best_by_pos[want_pos][0]
            give_adp, give_name = candidates[0]
            gap = give_adp - target_adp
            if gap > 40:
                verdict = "genuinely lopsided in your favor"
            elif gap > 10:
                verdict = "a mild lowball"
            elif gap >= 0:
                verdict = "close to fair value — not much of a lowball, check other options"
            else:
                verdict = "actually favors THEM — don't send this one"
            direction = "in your favor" if gap >= 0 else "against you"
            offers.append(
                f'  Offer {team_name}: send them "{give_name}" ({give_pos}, ADP {give_adp}) '
                f'for their "{target_name}" ({want_pos}, ADP {target_adp}) — '
                f"they're {len(best_by_pos[want_pos])}-deep at {want_pos} and thin at {give_pos}. "
                f"ADP gap: {abs(gap):.1f} picks {direction} ({verdict})."
            )
            n += 1
            if n >= count:
                return offers
    return offers


def cmd_offers(args):
    teams = load_league_rosters()
    my_roster = load_my_roster()
    config = load_config()
    adp = adp_lookup()

    if not teams:
        print(f"No rival roster data yet — fill in {profiles.league_rosters_path()} first.")
        return
    if not my_roster:
        print("Your own roster is empty — fill in my_roster.csv after the draft "
              "so offers know what you have to give up.")
        return

    targets = list(teams.items())
    if args.team:
        targets = [(n, r) for n, r in targets if n.lower() == args.team.lower()]
        if not targets:
            print(f'No team found matching "{args.team}". Try list-teams.')
            return
    elif not args.all:
        print("Pass --team \"Name\" or --all.")
        return

    for name, roster in targets:
        offers = build_offers_for_team(name, roster, my_roster, adp, config, args.count)
        print(f"\n{name}:")
        if offers:
            for o in offers:
                print(o)
        else:
            print("  No obvious lowball angle yet (roster data may be incomplete).")


def main():
    parser = argparse.ArgumentParser(description="Lowball trade offer generator")
    parser.add_argument("--profile", default=None,
                        help="Which person's setup to use (default: the FANTASY_PROFILE env var, else 'default'). Each profile has its own league settings, rosters and draft state.")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_list = sub.add_parser("list-teams", help="List rival teams on file")
    p_list.set_defaults(func=cmd_list_teams)

    p_off = sub.add_parser("offers", help="Generate lowball offers")
    p_off.add_argument("--team", default=None)
    p_off.add_argument("--all", action="store_true")
    p_off.add_argument("--count", type=int, default=3, help="Offers per team")
    p_off.set_defaults(func=cmd_offers)

    args = parser.parse_args()
    profiles.set_active_profile(args.profile)
    args.func(args)


if __name__ == "__main__":
    main()
