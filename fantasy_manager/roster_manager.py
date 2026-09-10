#!/usr/bin/env python3
"""
Post-draft weekly roster manager: start/sit, waivers, and the week review.

WHERE THE NUMBERS COME FROM: the in-season commands run on a weekly snapshot
imported from the Yahoo page you're already looking at (`browser_sync week`),
because that is the only source here with *this week's* projections, injury
designations and opponents in it. The pre-season commands still run on the
hand-maintained CSVs and the ADP board.

That split is the whole design. ADP is a draft-price signal; using it to pick a
Week 9 lineup would produce confident, wrong answers. So every command below
reports which signal it actually had — and declines to rank players when it
had none — rather than quietly falling back to draft price.

Once yahoo_client.py has approved credentials, point load_my_roster() at
yahoo_client.get_roster() and everything downstream keeps working unchanged.

Usage:
  python3 -m fantasy_manager.roster_manager week            # the whole weekly pass
  python3 -m fantasy_manager.roster_manager lineup          # start/sit only
  python3 -m fantasy_manager.roster_manager waivers --pos WR --top 10
  python3 -m fantasy_manager.roster_manager summary
  python3 -m fantasy_manager.roster_manager byeweeks

See WEEKLY.md for when in the week each of these matters.
"""
from __future__ import annotations

import argparse
import csv
import os
from collections import defaultdict

from fantasy_manager import profiles, weekly
from fantasy_manager.board import POS_ALIASES, apply_draft_state, build_board, load_config
from fantasy_manager.bye_weeks import BYE_WEEKS
from fantasy_manager.weekly import WeeklyPlayer



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


def _as_float(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _as_int(value):
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def load_weekly(path: str | None = None, week: int | None = None) -> list[WeeklyPlayer]:
    """This week's imported roster, or [] if nothing has been imported yet.

    Falls back to nothing rather than to my_roster.csv on purpose: the caller
    needs to be able to tell "I have weekly data" from "I have names only,"
    because the second one can't answer a start/sit question.
    """
    if path is None:
        profiles.ensure_profile()
        path = profiles.weekly_path(week)
    if not os.path.exists(path):
        return []
    out = []
    with open(path) as f:
        for row in csv.DictReader(f):
            out.append(WeeklyPlayer(
                name=row["name"],
                pos=POS_ALIASES.get(row["pos"], row["pos"]),
                team=row.get("team", ""),
                slot=row.get("slot") or None,
                status=row.get("status") or "",
                opponent=row.get("opponent") or None,
                proj=_as_float(row.get("proj")),
                bye=str(row.get("bye", "")).strip().lower() in {"true", "1", "yes"},
                bye_week=_as_int(row.get("bye_week")),
            ))
    return out


def roster_for_week(week: int | None = None) -> tuple[list[WeeklyPlayer], bool]:
    """(roster, has_weekly_data). Degrades to the plain post-draft roster with
    bye weeks filled in, which is enough to catch an illegal lineup but not
    enough to rank two healthy players."""
    imported = load_weekly(week=week)
    if imported:
        return imported, True

    config = load_config()
    current = weekly.current_week(config)
    return [
        WeeklyPlayer(
            name=r["name"], pos=r["pos"], team=r.get("team", ""),
            bye=(BYE_WEEKS.get(r.get("team", "").upper()) == current) if current else False,
        )
        for r in load_my_roster()
    ], False


def load_free_agents() -> tuple[list[WeeklyPlayer], str]:
    """(free agents, how we know). Prefers an imported waiver page; falls back
    to the ADP board minus everyone known to be rostered."""
    path = profiles.free_agents_path()
    if os.path.exists(path):
        imported = load_weekly(path=path)
        if imported:
            return imported, "imported waiver page"

    players, _ = build_board()
    rostered = rostered_names()
    # Both sources of "mine": the post-draft CSV and this week's import. Using
    # only the CSV recommends players already on your own roster whenever the
    # weekly import is the thing keeping it current.
    mine = {r["name"] for r in load_my_roster()} | {p.name for p in load_weekly()}
    avail = [p for p in players if p.name not in rostered and p.name not in mine]
    source = ("ADP board minus all known rosters" if rostered
              else "ADP board minus your roster only")
    return [
        WeeklyPlayer(name=p.name, pos=p.pos, team=p.team, proj=None)
        for p in sorted(avail, key=lambda p: p.adjusted_adp)
    ], source


def rostered_names() -> set[str]:
    """Everyone on any team in the league, from league_rosters.csv.

    This is what turns `waivers` from a best-available list into an actual
    waiver wire. Empty when the file hasn't been imported, and the caller says
    so rather than quietly recommending a player who is on someone's bench.
    """
    path = profiles.league_rosters_path()
    if not os.path.exists(path):
        return set()
    with open(path) as f:
        return {row["name"] for row in csv.DictReader(f) if row.get("name")}


def _print_lineup(lineup, show_bench: bool = True) -> None:
    print(f"{'SLOT':<8}{'PLAYER':<24}{'POS':<5}{'OPP':<8}{'ST':<5}PROJ")
    for assignment in lineup.starters:
        player = assignment.player
        if player is None:
            print(f"{assignment.slot:<8}{'— EMPTY —':<24}{'':<5}{'':<8}{'':<5}"
                  f"  ({assignment.empty_reason})")
            continue
        print(f"{assignment.slot:<8}{player.name:<24}{player.pos:<5}"
              f"{(player.opponent or '—'):<8}{(player.status_label or '—'):<5}"
              f"{'—' if player.proj is None else f'{player.proj:.2f}'}")
    if lineup.has_projections:
        print(f"{'':<8}{'':<24}{'':<5}{'':<8}{'TOTAL':<5} {lineup.projected:.2f}")

    if show_bench and lineup.bench:
        bench = ", ".join(
            f"{p.name}{f' ({p.status_label})' if p.status_label else ''}"
            for p in lineup.bench)
        print(f"\nBench: {bench}")


def cmd_lineup(args):
    """Start/sit: the best legal lineup, and what to change to get there."""
    config = load_config()
    roster, has_weekly = roster_for_week(args.week)
    if not roster:
        print(f"No roster on file yet — fill in {profiles.my_roster_path()} after your draft,\n"
              f"or import this week's page:\n"
              f"  python3 -m fantasy_manager.browser_sync week --url <My Team URL>")
        return

    week = args.week or weekly.current_week(config)
    starters = (config.get("roster") or {}).get("starters") or {}
    superflex = bool((config.get("league") or {}).get("superflex"))

    header = f"Week {week}" if week else "Lineup"
    print(f"{header} — recommended starters\n")

    if not has_weekly:
        print("!! No weekly data imported, so nothing below is ranked by this week's\n"
              "   projections — only by position eligibility and who's on bye. Import\n"
              "   the My Team page to get a real start/sit:\n"
              "     python3 -m fantasy_manager.browser_sync week --url <My Team URL>\n")

    best = weekly.optimal_lineup(roster, starters, superflex=superflex,
                                 allow_doubtful=args.allow_doubtful)
    _print_lineup(best)

    changes = weekly.lineup_changes(roster, best)
    print()
    if not changes:
        print("No changes needed — Yahoo already has your best lineup set."
              if any(p.slot for p in roster) else
              "Nothing to compare against: the import didn't record your current slots.")
    else:
        print("Changes to make in Yahoo:")
        for change in changes:
            if change.move_only:
                print(f"  - Move  {change.start_player.name:<22} ({change.reason})")
            elif change.start_player is None:
                print(f"  - Bench {change.bench_player.name:<22} ({change.reason})")
            elif change.bench_player is None:
                print(f"  - Start {change.start_player.name:<22} into {change.slot} ({change.reason})")
            else:
                print(f"  - {change.slot}: start {change.start_player.name}, "
                      f"bench {change.bench_player.name}  ({change.reason})")

    for warning in best.warnings:
        print(f"\n  ! {warning}")

    print("\nSet it yourself in Yahoo — nothing here submits a lineup.")


def cmd_waivers(args):
    """Waiver targets ranked by what they'd add to *your* lineup.

    The old version of this sorted the whole ADP board by draft price and
    filtered out your own players, which listed plenty of people who were on
    someone else's bench. Now it excludes every known roster, and measures a
    pickup against the player he would actually replace in your starting
    lineup rather than against the rest of the wire.
    """
    config = load_config()
    roster, has_weekly = roster_for_week(args.week)
    available, source = load_free_agents()
    system, faab = weekly.waiver_system(config)
    starters = (config.get("roster") or {}).get("starters") or {}
    superflex = bool((config.get("league") or {}).get("superflex"))

    if args.pos:
        available = [p for p in available if p.pos == args.pos.upper()]

    if not roster:
        # Without a roster there is nothing to measure a pickup against, but
        # "who's the best free agent" is still a fair question — so fall back
        # to the plain list rather than refusing to answer it.
        print(f"Best available  (pool: {source})")
        print("No roster on file yet, so these aren't ranked by what they'd add to "
              "your lineup — just by draft price.\n")
        print(f"  {'PLAYER':<26}{'POS':<5}TEAM")
        for candidate in available[: args.top]:
            print(f"  {candidate.name:<26}{candidate.pos:<5}{candidate.team}")
        return

    print(f"Waiver targets  (pool: {source})\n")
    if "your roster only" in source:
        print("!! league_rosters.csv is empty, so this can't tell a free agent from\n"
              "   someone on another team's bench. Import the league rosters page:\n"
              "     python3 -m fantasy_manager.browser_sync sync --url <League Rosters URL>\n")
    if not has_weekly or not any(p.proj is not None for p in available):
        missing = "your roster" if not has_weekly else "the free-agent pool"
        print(f"!! No weekly projections for {missing}, so gains over your current\n"
              "   starters can't be computed — this is ordered by draft price only.\n"
              "   Import the waiver page for real numbers:\n"
              "     python3 -m fantasy_manager.browser_sync week --free-agents --url <Players URL>\n")

    targets = weekly.evaluate_waiver_targets(
        available, roster, starters, superflex=superflex,
        faab_remaining=faab if system == "faab" else None, top=args.top)

    if not targets:
        print("Nothing on the wire clears your current starters.")
        return

    for target in targets:
        player = target.player
        line = f"  {player.name:<24}{player.pos:<5}{player.team:<5}".rstrip()
        line += "  " if line.endswith(player.team) else ""
        if system == "faab" and target.bid_low is not None:
            line += f"bid {target.bid_low}-{target.bid_high}"
            if faab:
                line += f" of {faab}"
        elif system == "priority":
            line += "worth your priority" if target.worth_priority else "not worth priority"
        print(line)
        print(f"      {target.rationale}" + (f" — {target.note}" if target.note else ""))
        if target.drop:
            print(f"      drop candidate: {target.drop.name} "
                  f"({target.drop.pos}, lowest-value bench spot)")

    print(f"\nWaiver system assumed: {system}."
          + (f" FAAB remaining: {faab}." if system == "faab" and faab else "")
          + "\nSet it in your profile's league.yaml under `waivers:` if that's wrong.")
    print("Claims get placed by you in Yahoo — nothing here submits one.")


def cmd_week(args):
    """The whole weekly pass in one report: lineup, byes ahead, waiver targets."""
    config = load_config()
    week = args.week or weekly.current_week(config)
    roster, has_weekly = roster_for_week(args.week)
    starters = (config.get("roster") or {}).get("starters") or {}

    print("=" * 68)
    print(f"  WEEKLY REVIEW — {weekly.week_label(config)}"
          + ("" if has_weekly else "   (no weekly data imported)"))
    print("=" * 68)

    if not roster:
        print(f"\nNo roster on file yet — fill in {profiles.my_roster_path()} after your draft.")
        return

    print("\n--- 1. START / SIT " + "-" * 49)
    cmd_lineup(argparse.Namespace(week=args.week, allow_doubtful=args.allow_doubtful))

    print("\n--- 2. BYES COMING UP " + "-" * 46)
    outlook = weekly.bye_outlook(roster, BYE_WEEKS, week, starters, weeks_ahead=args.weeks_ahead)
    if week is None:
        # Saying "nothing coming up" here would be a claim it hasn't checked.
        if ((config.get("season") or {}).get("week1_start")):
            print("  Season hasn't kicked off yet — bye checks start in Week 1.")
        else:
            print("  Can't look ahead without knowing the current week — set\n"
                  "  season.week1_start in your profile's league.yaml.")
    elif not outlook:
        print(f"  Nothing through week {week + args.weeks_ahead} leaves a starting slot short.")
    else:
        for target_week, players in outlook:
            names = ", ".join(f"{p.name} ({p.pos})" for p in players)
            print(f"  Week {target_week}: {names} — you'd be short a starter.")

    print("\n--- 3. WAIVER WIRE " + "-" * 49)
    cmd_waivers(argparse.Namespace(week=args.week, pos=None, top=args.top))

    print("\n--- 4. YOUR CALL " + "-" * 51)
    print("  Everything above is a recommendation. Set the lineup and place any\n"
          "  claims yourself in Yahoo — see WEEKLY.md for the run-through and\n"
          "  when in the week each piece matters.")


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

    p_lineup = sub.add_parser("lineup", help="Start/sit: best legal lineup and what to change")
    p_lineup.add_argument("--week", type=int, default=None,
                          help="Which week's import to use (default: the current one)")
    p_lineup.add_argument("--allow-doubtful", action="store_true",
                          help="Consider players listed Doubtful, which are excluded by default")
    p_lineup.set_defaults(func=cmd_lineup)

    p_week = sub.add_parser("week", help="The full weekly pass: lineup, byes ahead, waivers")
    p_week.add_argument("--week", type=int, default=None)
    p_week.add_argument("--top", type=int, default=8, help="Waiver targets to show")
    p_week.add_argument("--weeks-ahead", type=int, default=3,
                        help="How far ahead to look for bye-week trouble")
    p_week.add_argument("--allow-doubtful", action="store_true")
    p_week.set_defaults(func=cmd_week)

    p_wai = sub.add_parser("waivers", help="Waiver targets ranked by what they add to your lineup")
    p_wai.add_argument("--pos", default=None)
    p_wai.add_argument("--top", type=int, default=15)
    p_wai.add_argument("--week", type=int, default=None)
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
