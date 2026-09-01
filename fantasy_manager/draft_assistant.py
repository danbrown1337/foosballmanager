#!/usr/bin/env python3
"""
Live draft-day assistant.

Usage (run from the fantasy_manager/ project root):

  # Mark a pick as it happens in Yahoo's draft room:
  python3 -m fantasy_manager.draft_assistant pick "Ja'Marr Chase" --by mine
  python3 -m fantasy_manager.draft_assistant pick "Bijan Robinson" --by rival

  # See the best available board:
  python3 -m fantasy_manager.draft_assistant board
  python3 -m fantasy_manager.draft_assistant board --pos RB --top 15

  # Get a recommendation given your roster so far + positional scarcity:
  python3 -m fantasy_manager.draft_assistant recommend

  # See who's on your team:
  python3 -m fantasy_manager.draft_assistant myteam

State persists in draft_state.json in the project root between commands,
so you can run this one command at a time as the live draft unfolds
without losing track of who's gone.
"""
from __future__ import annotations

import argparse
import os
import sys
from difflib import get_close_matches

from fantasy_manager.autopilot import auto_pick
from fantasy_manager import profiles
from fantasy_manager.board import (
    apply_draft_state as apply_state,
    build_board,
    load_draft_state as load_state,
    save_draft_state as save_state,
    scarcity_report,
)


def find_player(players, query):
    names = [p.name for p in players]
    exact = [p for p in players if p.name.lower() == query.lower()]
    if exact:
        return exact[0]
    matches = get_close_matches(query, names, n=1, cutoff=0.6)
    if matches:
        return next(p for p in players if p.name == matches[0])
    return None


def cmd_pick(args):
    players, config = build_board()
    state = load_state()
    apply_state(players, state)

    player = find_player(players, args.name)
    if player is None:
        print(f'No close match found for "{args.name}". Check spelling.')
        sys.exit(1)
    if player.drafted_by:
        print(f"{player.name} is already marked drafted ({player.drafted_by}).")
        sys.exit(1)

    state["drafted"][player.name] = args.by
    save_state(state)
    print(f"Marked {player.name} ({player.pos}, {player.team}) as drafted by: {args.by}")


def cmd_board(args):
    players, config = build_board()
    state = load_state()
    apply_state(players, state)

    avail = [p for p in players if p.drafted_by is None]
    if args.pos:
        avail = [p for p in avail if p.pos == args.pos.upper()]
    avail.sort(key=lambda p: p.adp)

    print(f"{'RANK':<6}{'PLAYER':<26}{'POS':<5}{'TEAM':<6}{'ADP':<8}TIER")
    for p in avail[: args.top]:
        print(f"{p.rank:<6}{p.name:<26}{p.pos:<5}{p.team:<6}{p.adp:<8}{p.tier}")


def cmd_recommend(args):
    players, config = build_board()
    state = load_state()
    apply_state(players, state)

    mine = [p for p in players if p.drafted_by == "mine"]
    starters = config["roster"]["starters"]
    have = {pos: sum(1 for p in mine if p.pos == pos) for pos in starters}

    print("Your roster so far:")
    if mine:
        for p in sorted(mine, key=lambda p: p.adp):
            print(f"  {p.pos:<4}{p.name} ({p.team})")
    else:
        print("  (empty)")
    print()

    print("Positional scarcity right now:")
    for line in scarcity_report(players, config):
        print(f"  {line}")
    print()

    # Needs: starters not yet filled, weighted by how thin the position is
    needs = [pos for pos, n in starters.items() if pos != "FLEX" and have.get(pos, 0) < n]
    avail = [p for p in players if p.drafted_by is None]
    avail.sort(key=lambda p: p.adp)

    print("Top recommendation(s):")
    if needs:
        for pos in needs:
            best = next((p for p in avail if p.pos == pos), None)
            if best:
                print(f"  Need {pos}: best available is {best.name} ({best.team}), Tier {best.tier}, ADP {best.adp}")
    else:
        # All starting spots filled — best player available regardless of position
        best = avail[0] if avail else None
        if best:
            print(f"  Starters filled — best player available: {best.name} ({best.pos}, {best.team}), Tier {best.tier}")

    print()
    print("Overall best-player-available (top 8):")
    for p in avail[:8]:
        print(f"  {p.name:<24}{p.pos:<4}{p.team:<5}ADP {p.adp:<7}Tier {p.tier}")


def cmd_autopick(args):
    """The full-autopilot decision: one player, with reasoning, optionally
    committed to draft_state.json in the same step (--commit) so this can
    be called directly from the live-draft watch loop."""
    players, config = build_board()
    state = load_state()
    apply_state(players, state)

    decision = auto_pick(players, config)
    if decision is None:
        print("No players left available.")
        return

    p = decision.player
    tag = " [NEED OVERRIDE]" if decision.need_override else ""
    print(f"AUTOPICK: {p.name} ({p.pos}, {p.team}) — Tier {p.tier}{tag}")
    print(f"  {decision.reason}")

    if args.commit:
        state["drafted"][p.name] = "mine"
        save_state(state)
        print(f"  Committed: marked {p.name} as drafted by mine.")


def cmd_myteam(args):
    players, config = build_board()
    state = load_state()
    apply_state(players, state)
    mine = sorted([p for p in players if p.drafted_by == "mine"], key=lambda p: p.adp)
    if not mine:
        print("No picks marked as yours yet.")
        return
    for p in mine:
        print(f"{p.pos:<4}{p.name:<24}{p.team:<5}ADP {p.adp}")


def cmd_reset(args):
    state_path = profiles.draft_state_path()
    if os.path.exists(state_path):
        os.remove(state_path)
    print("Draft state cleared.")


def main():
    parser = argparse.ArgumentParser(description="Live fantasy draft assistant")
    parser.add_argument("--profile", default=None,
                        help="Which person's setup to use (default: the FANTASY_PROFILE env var, else 'default'). Each profile has its own league settings, rosters and draft state.")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_pick = sub.add_parser("pick", help="Mark a player as drafted")
    p_pick.add_argument("name")
    p_pick.add_argument("--by", choices=["mine", "rival"], required=True)
    p_pick.set_defaults(func=cmd_pick)

    p_board = sub.add_parser("board", help="Show best-available board")
    p_board.add_argument("--pos", default=None)
    p_board.add_argument("--top", type=int, default=25)
    p_board.set_defaults(func=cmd_board)

    p_rec = sub.add_parser("recommend", help="Get a pick recommendation")
    p_rec.set_defaults(func=cmd_recommend)

    p_auto = sub.add_parser("autopick", help="Full-autopilot: one decision, with reasoning")
    p_auto.add_argument("--commit", action="store_true", help="Also mark the pick as drafted by mine")
    p_auto.set_defaults(func=cmd_autopick)

    p_team = sub.add_parser("myteam", help="Show your drafted roster")
    p_team.set_defaults(func=cmd_myteam)

    p_reset = sub.add_parser("reset", help="Clear draft state (start over)")
    p_reset.set_defaults(func=cmd_reset)

    args = parser.parse_args()
    profiles.set_active_profile(args.profile)
    args.func(args)


if __name__ == "__main__":
    main()
