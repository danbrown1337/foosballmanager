"""How hard a defence has actually been on a position, from your own imports.

WHY THIS EXISTS AND WHAT IT DELIBERATELY DOES NOT DO
----------------------------------------------------
Every other number in this project is Yahoo's. Yahoo's weekly projection
already prices some matchup effect in — nobody knows how much — so an
independent adjustment layered on top would double-count by an unknown amount
and quietly change which nine players you start. That is the worst possible
failure mode here, because it is invisible: the lineup still looks reasonable.

So this module NEVER touches a projection and never reorders a lineup. It
reports what the defence has done, next to Yahoo's number, and the manager
decides. `optimal_lineup` does not import this module and must not.

WHAT IT MEASURES
----------------
Not "points allowed to RBs", the number you see on fantasy sites. That is a
league-wide total over every back in the NFL, and this has no such data. What
it has is the players your league rosters and the ones on its wire, which is
where the honest metric comes from:

    the average points a fantasy-relevant player at this position has scored
    against this defence

A per-player average, not a team total. Comparable across defences, which is
all a matchup read needs, but it is not the same statistic as the one on
FantasyPros and is not labelled as though it were.

WHERE THE DATA COMES FROM
-------------------------
Your own weekly imports, and nothing else. `browser_sync week` saves a
snapshot per week, and each row carries the opponent faced and — from week 2
on — the points actually scored. Accumulate those and you have a real record
of what happened, sourced from the same pages every other number here comes
from.

The consequence worth being blunt about: this says nothing until several weeks
have been imported, and it can never say anything about a week that was not
imported at the time. There is no backfill. A season's worth of matchup data
only exists if collection starts early, which is the whole argument for having
built it before it could answer anything.

It also refuses rather than guessing when the sample is thin. Two games is not
evidence about a defence, and a confident ranking off two games is worse than
no ranking, because it will be believed.
"""
from __future__ import annotations

import csv
import glob
import os
import re
import statistics
from dataclasses import dataclass

from . import profiles
from .weekly import HARD_OUT, SOFT_OUT

# Positions where a matchup read is meaningful and the sample is big enough to
# be worth computing. Kickers and defences are excluded deliberately: their
# scoring is dominated by game script and their own offence, not by who they
# are facing, and treating them the same way would produce confident noise.
RATED_POSITIONS = ("QB", "RB", "WR", "TE")

# Thresholds below which no rating is produced. Chosen to be conservative: a
# defence that has played three games, seen four fantasy-relevant players at a
# position, is the least that can be called a pattern rather than a result.
MIN_GAMES = 3
MIN_OBSERVATIONS = 4

# "@CAR" / "vs NYJ" -> the defence faced.
OPPONENT_TEAM = re.compile(r"^(?:@|vs\.?\s*)\s*(?P<team>[A-Za-z]{2,3})$", re.I)

# week03.csv, not week_current.csv — the latter is overwritten in place and
# would double-count whichever week happened to be current at import time.
WEEK_FILE = re.compile(r"week(?P<week>\d{2})\.csv$")


@dataclass
class Observation:
    """One player's actual result against one defence, in one week."""
    week: int
    name: str
    pos: str
    defense: str
    points: float


@dataclass
class DefenseRating:
    """What one defence has allowed one position, and how it ranks."""
    team: str
    pos: str
    games: int
    observations: int
    points_per_player: float
    rank: int          # 1 = has allowed the most, i.e. the softest matchup
    of: int            # how many defences had enough data to be ranked

    @property
    def label(self) -> str:
        return (f"{_ordinal(self.rank)}-most points allowed to {self.pos}s "
                f"of {self.of} rated ({self.observations} players, "
                f"{self.games} games)")

    @property
    def verdict(self) -> str:
        """Soft / neutral / tough, by thirds of the rated field.

        Thirds rather than a fixed points threshold: what counts as a lot of
        points differs by position, and the only question a lineup decision
        actually asks is "compared to the alternatives".
        """
        if self.of < 3:
            return "unrated"
        third = self.of / 3
        if self.rank <= third:
            return "soft"
        return "tough" if self.rank > 2 * third else "neutral"


def _ordinal(n: int) -> str:
    if 10 <= n % 100 <= 20:
        return f"{n}th"
    return f"{n}{ {1: 'st', 2: 'nd', 3: 'rd'}.get(n % 10, 'th') }"


def defense_faced(opponent: str | None) -> str | None:
    """The team on the other side of "@CAR" or "vs NYJ"."""
    if not opponent:
        return None
    found = OPPONENT_TEAM.match(opponent.strip())
    return found.group("team").upper() if found else None


def _countable(row: dict) -> bool:
    """Whether this row is evidence about a defence.

    A zero from a player who was inactive says nothing about who he was
    playing, and counting it would mark every defence that faced an injured
    starter as tough. Only rows for someone who could actually play count.
    """
    status = (row.get("status") or "").strip().upper()
    if status in HARD_OUT or status in SOFT_OUT:
        return False
    return str(row.get("bye") or "").strip().lower() not in ("true", "1", "yes")


def load_history(profile: str | None = None) -> list[Observation]:
    """Every past week's import, as observations against a defence.

    Reads the per-week snapshots `browser_sync week` writes. Rows with no
    actual points are skipped rather than treated as zero — before a game is
    played there is no result, and "no information" is not "scored nothing".
    """
    directory = profiles.profile_dir(profile)
    out: list[Observation] = []
    for path in sorted(glob.glob(os.path.join(directory, "week*.csv"))):
        found = WEEK_FILE.search(os.path.basename(path))
        if not found:
            continue                      # week_current.csv, deliberately
        week = int(found.group("week"))
        try:
            with open(path, newline="") as f:
                rows = list(csv.DictReader(f))
        except OSError:
            continue
        for row in rows:
            pos = (row.get("pos") or "").strip().upper()
            defense = defense_faced(row.get("opponent"))
            raw = (row.get("actual") or "").strip()
            if pos not in RATED_POSITIONS or not defense or not raw:
                continue
            if not _countable(row):
                continue
            try:
                points = float(raw)
            except ValueError:
                continue
            out.append(Observation(week=week, name=(row.get("name") or "").strip(),
                                   pos=pos, defense=defense, points=points))
    return out


def build_ratings(observations: list[Observation],
                  min_games: int = MIN_GAMES,
                  min_observations: int = MIN_OBSERVATIONS,
                  ) -> dict[tuple[str, str], DefenseRating]:
    """Rank every defence that has enough data, per position.

    Ranked within the position, not across all of them: fifteen points against
    a defence means something different for a quarterback than a tight end, and
    a single combined table would put every QB matchup at the soft end.
    """
    grouped: dict[tuple[str, str], list[Observation]] = {}
    for observation in observations:
        grouped.setdefault((observation.defense, observation.pos), []).append(observation)

    eligible: dict[tuple[str, str], tuple[float, int, int]] = {}
    for key, rows in grouped.items():
        games = len({r.week for r in rows})
        if games < min_games or len(rows) < min_observations:
            continue
        eligible[key] = (statistics.mean(r.points for r in rows), games, len(rows))

    ratings: dict[tuple[str, str], DefenseRating] = {}
    for pos in RATED_POSITIONS:
        in_pos = {k: v for k, v in eligible.items() if k[1] == pos}
        # Most points allowed first — rank 1 is the matchup you want. Ties break
        # on team name so the ranking is stable between runs rather than
        # shuffling with dictionary order.
        order = sorted(in_pos.items(), key=lambda kv: (-kv[1][0], kv[0][0]))
        for index, (key, (mean, games, count)) in enumerate(order, start=1):
            ratings[key] = DefenseRating(
                team=key[0], pos=pos, games=games, observations=count,
                points_per_player=round(mean, 2), rank=index, of=len(order))
    return ratings


def rate(player, ratings: dict[tuple[str, str], DefenseRating]) -> DefenseRating | None:
    """This week's matchup for one player, if the defence has been rated."""
    defense = defense_faced(getattr(player, "opponent", None))
    if not defense:
        return None
    return ratings.get((defense, (getattr(player, "pos", "") or "").upper()))


def coverage(observations: list[Observation],
             ratings: dict[tuple[str, str], DefenseRating]) -> str:
    """One line on what the data can and cannot support yet.

    Printed every time rather than only when empty. A matchup read built on
    four weeks of one league's rosters deserves to say so on the same screen as
    its own conclusions, not in a doc nobody rereads.
    """
    if not observations:
        return ("No completed weeks imported yet, so there is nothing to measure. "
                "This builds up as you import each week — it cannot be backfilled.")
    weeks = sorted({o.week for o in observations})
    if not ratings:
        return (f"{len(observations)} results from week(s) {', '.join(map(str, weeks))} — "
                f"not enough yet. A defence needs {MIN_GAMES} games and "
                f"{MIN_OBSERVATIONS} players at a position before it is rated.")
    return (f"From {len(observations)} results across week(s) "
            f"{', '.join(map(str, weeks))}, in your league only. "
            "Average points per fantasy-relevant player, not league-wide totals.")
