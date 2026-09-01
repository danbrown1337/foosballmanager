"""
Core draft board: loads ADP data + league config, builds position tiers,
and computes replacement-level cutoffs so the assistant can flag scarcity
("only 2 Tier-3 WRs left") instead of just sorting by ADP.

No external player-projection data is used here on purpose — before the
league's real scoring/roster settings and Yahoo data are wired in, ADP
(pulled from live 2026 mock drafts) is the most honest signal available.
Swap in real projections later by adding a "proj_pts" column to the CSV
and the VBD path will use it automatically.
"""
from __future__ import annotations

import csv
import json
import os
from dataclasses import dataclass, field

import yaml

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_CONFIG = os.path.join(ROOT, "config", "league.yaml")
DEFAULT_ADP = os.path.join(ROOT, "data", "adp_2026_ppr.csv")
DEFAULT_NOTES = os.path.join(ROOT, "data", "player_notes_2026.csv")
STATE_PATH = os.path.join(ROOT, "draft_state.json")


@dataclass
class Player:
    rank: int
    name: str
    team: str
    pos: str
    adp: float
    tier: int = 0
    drafted_by: str | None = None  # None = available, "mine", or a rival name
    note_tag: str | None = None    # bust | injury_watch | breakout | value_note
    note: str | None = None
    adjustment: float = 0.0        # + = research says worse than ADP, - = better

    @property
    def adjusted_adp(self) -> float:
        """ADP nudged by researched risk/upside — the signal auto-pick sorts
        on. Raw .adp is kept untouched for display so you can always see
        the market's number alongside the research-informed one."""
        return self.adp + self.adjustment


def load_config(path: str = DEFAULT_CONFIG) -> dict:
    with open(path) as f:
        return yaml.safe_load(f)


# Source data uses a few position labels that don't match our roster/config
# vocabulary (e.g. FantasyFootballCalculator labels kickers "PK") — normalize
# on load so board/roster code only ever has to deal with QB/RB/WR/TE/K/DEF.
POS_ALIASES = {"PK": "K", "DST": "DEF", "D/ST": "DEF"}


def load_players(path: str = DEFAULT_ADP) -> list[Player]:
    players = []
    with open(path) as f:
        for row in csv.DictReader(f):
            pos = POS_ALIASES.get(row["pos"], row["pos"])
            players.append(
                Player(
                    rank=int(row["rank"]),
                    name=row["name"],
                    team=row["team"],
                    pos=pos,
                    adp=float(row["adp"]),
                )
            )
    return players


def load_player_notes(path: str = DEFAULT_NOTES) -> dict[str, dict]:
    """Researched risk/upside notes (bust concerns, injury watches, breakout
    cases) pulled from beat-writer and analyst coverage just before the
    2026 season. See data/player_notes_2026.csv for sourcing per player."""
    if not os.path.exists(path):
        return {}
    notes = {}
    with open(path) as f:
        for row in csv.DictReader(f):
            notes[row["name"]] = {
                "tag": row["tag"],
                "adjustment": float(row["adjustment"]),
                "note": row["note"],
            }
    return notes


def apply_notes(players: list[Player], notes: dict[str, dict]) -> None:
    for p in players:
        n = notes.get(p.name)
        if not n:
            continue
        p.note_tag = n["tag"]
        p.note = n["note"]
        # "bust"/"injury_watch" push adjusted_adp later (worse); "breakout"
        # pulls it earlier (better); "value_note" is informational context
        # on an ADP-inefficiency call and also pushes later.
        sign = -1 if n["tag"] == "breakout" else 1
        p.adjustment = sign * n["adjustment"]


def assign_tiers(players: list[Player], relative_gap: float = 0.15, min_gap: float = 3.0) -> None:
    """
    Tier players within each position by clustering on ADP gaps.
    A new tier starts whenever the jump to the next player's ADP is at
    least `min_gap` picks AND at least `relative_gap` of the current ADP —
    early first-round gaps are tiny in absolute terms but still meaningful,
    late-round gaps need a bigger absolute jump to mean anything.
    """
    by_pos: dict[str, list[Player]] = {}
    for p in players:
        by_pos.setdefault(p.pos, []).append(p)

    for pos, plist in by_pos.items():
        plist.sort(key=lambda p: p.adp)
        tier = 1
        plist[0].tier = tier
        for prev, cur in zip(plist, plist[1:]):
            gap = cur.adp - prev.adp
            threshold = max(min_gap, prev.adp * relative_gap)
            if gap >= threshold:
                tier += 1
            cur.tier = tier


def replacement_ranks(config: dict) -> dict[str, int]:
    """
    Rough replacement-level draft rank per position, given league size and
    starting roster. The FLEX spot is split ~60/35/5 between RB/WR/TE,
    which is the standard assumption absent real projections.
    """
    teams = config["league"]["num_teams"]
    starters = config["roster"]["starters"]
    flex = starters.get("FLEX", 0)

    effective = {
        "QB": starters.get("QB", 1),
        "RB": starters.get("RB", 2) + 0.60 * flex,
        "WR": starters.get("WR", 2) + 0.35 * flex,
        "TE": starters.get("TE", 1) + 0.05 * flex,
        "K": starters.get("K", 1),
        "DEF": starters.get("DEF", 1),
    }
    return {pos: max(1, round(teams * mult)) for pos, mult in effective.items()}


def load_draft_state(path: str = STATE_PATH) -> dict:
    """Shared draft-in-progress state: {"drafted": {name: "mine"|"rival"}}."""
    if os.path.exists(path):
        with open(path) as f:
            return json.load(f)
    return {"drafted": {}}


def save_draft_state(state: dict, path: str = STATE_PATH) -> None:
    with open(path, "w") as f:
        json.dump(state, f, indent=2)


def apply_draft_state(players: list[Player], state: dict | None = None) -> dict:
    """Stamp .drafted_by onto each Player from saved state (or load it if
    not passed). Returns the state dict in case the caller wants it too."""
    if state is None:
        state = load_draft_state()
    by_name = {p.name: p for p in players}
    for name, by in state["drafted"].items():
        if name in by_name:
            by_name[name].drafted_by = by
    return state


def build_board(
    config_path: str = DEFAULT_CONFIG, adp_path: str = DEFAULT_ADP, notes_path: str = DEFAULT_NOTES
) -> tuple[list[Player], dict]:
    config = load_config(config_path)
    players = load_players(adp_path)
    apply_notes(players, load_player_notes(notes_path))
    assign_tiers(players)
    return players, config


def scarcity_report(players: list[Player], config: dict) -> list[str]:
    """One line per position: how many undrafted players remain before the
    replacement-level cliff, and how many are left in the current top tier."""
    repl = replacement_ranks(config)
    lines = []
    for pos in ["QB", "RB", "WR", "TE", "K", "DEF"]:
        avail = [p for p in players if p.pos == pos and p.drafted_by is None]
        avail.sort(key=lambda p: p.adp)
        if not avail:
            lines.append(f"{pos}: none left")
            continue
        top_tier = avail[0].tier
        in_top_tier = sum(1 for p in avail if p.tier == top_tier)
        drafted_at_pos = sum(1 for p in players if p.pos == pos and p.drafted_by is not None)
        # How many more players can go at this position before the
        # startable pool (replacement rank) is exhausted.
        remaining_startable = max(0, repl[pos] - drafted_at_pos)
        lines.append(
            f"{pos}: {in_top_tier} left in Tier {top_tier} "
            f"({remaining_startable} startable-caliber players left league-wide)"
        )
    return lines
