"""
In-season weekly engine: start/sit and waiver evaluation.

WHY THIS IS A SEPARATE MODULE FROM board.py: everything in board.py is a
*draft-price* signal. ADP answers "what did the market pay for this player in
August," which is the right question on draft day and the wrong one in Week 9.
Starting your roster by ADP every week would be roughly right in Week 1 and
confidently wrong by midseason — and confidently wrong is worse than useless
to someone trusting it with a lineup.

So nothing here ranks two healthy players against each other unless it has a
*weekly* number to do it with. That number comes from the Yahoo page you are
already looking at (see browser_sync.myteam). When it's missing, the report
says so and declines to guess rather than falling back to ADP silently.

SCOPE: recommend-only. Nothing here submits a lineup, an add, or a drop —
the same line already drawn in trade_targeter.py and browser_sync.py. The
manager makes the move in Yahoo's own UI. That is deliberate: a lineup set by
a script against a page it half-understands is how you start a player on bye.
"""
from __future__ import annotations

import datetime
from collections import defaultdict
from dataclasses import dataclass, field

# Yahoo's injury/status designations, split by what they mean for a lineup.
#
# The split is a policy call, so it's spelled out rather than buried:
#   HARD_OUT  — cannot play. Starting one scores zero. Never recommended.
#   SOFT_OUT  — can technically play, usually doesn't. Excluded by default
#               because Yahoo's projection often doesn't zero these out, so
#               trusting the number would quietly start a player who sits.
#   FLAGGED   — expected to play. Startable, but surfaced every time, with the
#               best healthy alternative shown so the call stays the manager's.
HARD_OUT = {"O", "OUT", "IR", "IR-R", "SUSP", "PUP", "NA", "BYE"}
SOFT_OUT = {"D", "DOUBTFUL"}
FLAGGED = {"Q", "QUESTIONABLE", "GTD", "P", "PROBABLE"}

# Which positions each flex-style slot will accept. Yahoo writes the standard
# one "W/R/T"; the config template writes "FLEX". Both mean the same thing.
FLEX_SLOTS = {
    "FLEX": {"RB", "WR", "TE"},
    "W/R/T": {"RB", "WR", "TE"},
    "WRT": {"RB", "WR", "TE"},
    "SUPERFLEX": {"QB", "RB", "WR", "TE"},
    "SFLEX": {"QB", "RB", "WR", "TE"},
    "OP": {"QB", "RB", "WR", "TE"},
    "Q/W/R/T": {"QB", "RB", "WR", "TE"},
}

BENCH_SLOTS = {"BN", "BE", "BENCH", "IR", "IR-R", "NA"}


@dataclass
class WeeklyPlayer:
    """One roster row as the Yahoo My Team page renders it for a given week.

    Everything past name/pos/team is optional because a hand-pasted page may
    carry less than a scraped one, and half a row is still worth having.
    """
    name: str
    pos: str
    team: str
    slot: str | None = None        # where Yahoo currently has them
    status: str = ""               # "", Q, D, O, IR, SUSP, BYE, ...
    opponent: str | None = None    # "@GB", "vs NYJ", None
    proj: float | None = None      # this week's projected points, per Yahoo
    bye: bool = False

    @property
    def playable(self) -> bool:
        """Can be started at all this week — the hard filter, no judgement."""
        return not self.bye and self.status.upper() not in HARD_OUT

    @property
    def startable(self) -> bool:
        """Playable *and* not carrying a designation that usually means sits."""
        return self.playable and self.status.upper() not in SOFT_OUT

    @property
    def flagged(self) -> bool:
        return self.status.upper() in FLAGGED

    @property
    def status_label(self) -> str:
        if self.bye:
            return "BYE"
        return self.status.upper()


@dataclass
class SlotAssignment:
    slot: str
    player: WeeklyPlayer | None
    # Set when nobody eligible was available for the slot — an empty starting
    # spot scores zero, which is the single most expensive thing that can go
    # wrong in a week, so it's carried explicitly rather than left implicit.
    empty_reason: str | None = None


@dataclass
class Lineup:
    starters: list[SlotAssignment] = field(default_factory=list)
    bench: list[WeeklyPlayer] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    @property
    def projected(self) -> float:
        return sum(a.player.proj or 0.0 for a in self.starters if a.player)

    @property
    def has_projections(self) -> bool:
        return any(a.player and a.player.proj is not None for a in self.starters)

    def named(self) -> set[str]:
        return {a.player.name for a in self.starters if a.player}


def expand_slots(starters: dict, superflex: bool = False) -> list[str]:
    """Turn {"QB": 1, "RB": 2, "FLEX": 2} into ["QB", "RB", "RB", "FLEX", "FLEX"].

    Order is most-restrictive-first, and that ordering is load-bearing rather
    than cosmetic: the fill below is greedy, so a slot that accepts fewer
    positions has to claim its player before a wider one takes him. A league
    running both a W/R/T and a superflex makes this concrete — fill the
    superflex first with the best player left and it can swallow the only
    running back, stranding the W/R/T next to a quarterback it cannot use.
    Dedicated slots accept exactly one position, so they come first of all.

    An absent position stays absent: a league with no kicker slot gets no
    kicker, exactly as the draft engine treats it.
    """
    dedicated, flex = [], []
    for slot, count in (starters or {}).items():
        slot = str(slot).upper()
        try:
            count = int(count)
        except (TypeError, ValueError):
            continue
        target = flex if slot in FLEX_SLOTS else dedicated
        target.extend([slot] * max(0, count))
    if superflex:
        flex = ["SUPERFLEX" if s in FLEX_SLOTS else s for s in flex]
    flex.sort(key=lambda s: (len(FLEX_SLOTS[s]), s))
    return dedicated + flex


def slot_accepts(slot: str, pos: str) -> bool:
    slot = slot.upper()
    if slot in FLEX_SLOTS:
        return pos.upper() in FLEX_SLOTS[slot]
    return slot == pos.upper()


def _rank_key(player: WeeklyPlayer):
    """Sort key for "who is better this week".

    Players without a projection sort last among the startable rather than
    being treated as zero — "no information" and "projected to score nothing"
    are different claims, and only one of them is true.
    """
    return (player.proj is None, -(player.proj or 0.0), player.name)


def optimal_lineup(
    players: list[WeeklyPlayer],
    starters: dict,
    superflex: bool = False,
    allow_doubtful: bool = False,
) -> Lineup:
    """Best legal lineup by projected points.

    WHY GREEDY IS ACTUALLY OPTIMAL HERE, not just convenient: fill each
    dedicated slot with the top players at that position, then fill flex from
    whoever is left. Suppose some optimal lineup starts RB-b in an RB slot
    while a higher-projected RB-a sits. If RB-a is benched, swapping strictly
    improves it, so it wasn't optimal. If RB-a is in a flex slot, swapping the
    two leaves the total unchanged (both slots accept RBs). Either way there is
    an optimal lineup with the top RBs in the RB slots, and induction over the
    remaining slots gives the rest. test_weekly.py checks this against
    exhaustive enumeration on random rosters rather than taking it on faith.
    """
    lineup = Lineup()
    pool = [p for p in players if p.startable or (allow_doubtful and p.playable)]

    benched_out = [p for p in players if not p.playable]
    for p in benched_out:
        if p.slot and p.slot.upper() not in BENCH_SLOTS:
            lineup.warnings.append(
                f"{p.name} is in your {p.slot} slot but is {p.status_label} — that slot scores 0 as it stands."
            )

    if not allow_doubtful:
        for p in players:
            if p.playable and not p.startable:
                lineup.warnings.append(
                    f"{p.name} is {p.status_label} and left out. Re-run with --allow-doubtful to consider him."
                )

    remaining = sorted(pool, key=_rank_key)
    for slot in expand_slots(starters, superflex=superflex):
        pick = next((p for p in remaining if slot_accepts(slot, p.pos)), None)
        if pick is None:
            lineup.starters.append(SlotAssignment(
                slot=slot, player=None,
                empty_reason=f"nobody healthy on your roster fills {slot}",
            ))
            continue
        remaining.remove(pick)
        lineup.starters.append(SlotAssignment(slot=slot, player=pick))

    lineup.bench = remaining + benched_out

    missing = [a.player.name for a in lineup.starters
               if a.player and a.player.proj is None]
    if missing:
        lineup.warnings.append(
            "No weekly projection for " + ", ".join(sorted(missing))
            + " — they were slotted on position eligibility alone, not ranked. "
              "Re-import the My Team page to pick up projections."
        )
    return lineup


def canonical_slot(slot: str | None) -> str:
    """Yahoo writes the standard flex slot "W/R/T"; the config template writes
    "FLEX". Comparing the raw strings would report a move between two names for
    the same slot, so both collapse to one label first."""
    if not slot:
        return ""
    slot = slot.upper()
    if slot in FLEX_SLOTS:
        return "FLEX" if FLEX_SLOTS[slot] == {"RB", "WR", "TE"} else "SUPERFLEX"
    return slot


@dataclass
class LineupChange:
    """One swap, phrased the way the manager has to execute it in Yahoo."""
    slot: str
    bench_player: WeeklyPlayer | None   # who comes out
    start_player: WeeklyPlayer | None   # who goes in
    gain: float | None                  # projected points gained, when known
    reason: str
    # A player already starting who has to be dragged to a different slot.
    # Distinct from a swap because nobody is benched, and easy to miss: leave
    # the tight end in a flex spot and the TE slot stays empty at kickoff.
    move_only: bool = False


def lineup_changes(current: list[WeeklyPlayer], best: Lineup) -> list[LineupChange]:
    """Diff Yahoo's current lineup against the optimal one.

    This — not the optimal lineup itself — is the actionable output. "Start
    these nine" makes the manager re-derive what to click; "bench X for Y"
    is the move.
    """
    currently_starting = {
        p.name: p for p in current
        if p.slot and p.slot.upper() not in BENCH_SLOTS
    }
    should_start = best.named()

    coming_in = [a for a in best.starters
                 if a.player and a.player.name not in currently_starting]
    going_out = [p for p in currently_starting.values() if p.name not in should_start]

    changes: list[LineupChange] = []
    for assignment in coming_in:
        incoming = assignment.player
        # Pair each promotion with a demotion at a slot that can take the
        # incoming player, so the instruction is executable as written.
        match = next(
            (p for p in going_out if slot_accepts(assignment.slot, p.pos)),
            None,
        ) or (going_out[0] if going_out else None)
        if match:
            going_out.remove(match)

        gain = None
        if incoming.proj is not None and match is not None and match.proj is not None:
            gain = round(incoming.proj - match.proj, 2)

        if match is None:
            reason = f"{assignment.slot} is empty"
        elif not match.playable:
            reason = f"{match.name} is {match.status_label}"
        elif gain is not None:
            reason = f"projects {gain:+.2f} over {match.name}"
        else:
            reason = f"ranked above {match.name}"

        changes.append(LineupChange(
            slot=assignment.slot, bench_player=match,
            start_player=incoming, gain=gain, reason=reason,
        ))

    # Anyone left over has to come out even though nobody specific replaces
    # them — an over-full slot, or a player who is simply not startable.
    for orphan in going_out:
        changes.append(LineupChange(
            slot=orphan.slot or orphan.pos, bench_player=orphan, start_player=None,
            gain=None,
            reason=f"{orphan.name} is {orphan.status_label}" if not orphan.playable
                   else f"{orphan.name} is out-projected by your bench",
        ))

    # Finally, players who stay in the lineup but belong in a different slot.
    for assignment in best.starters:
        player = assignment.player
        if player is None or player.name not in currently_starting:
            continue
        was = canonical_slot(currently_starting[player.name].slot)
        now = canonical_slot(assignment.slot)
        if was and now and was != now:
            changes.append(LineupChange(
                slot=assignment.slot, bench_player=None, start_player=player,
                gain=None, move_only=True,
                reason=f"move from {currently_starting[player.name].slot} to {assignment.slot}",
            ))
    return changes


# --- Waivers -----------------------------------------------------------------
#
# The bands below are a heuristic, not a market price, so they live here in the
# open where they can be argued with rather than inside the reporting code.
# The number that matters is the projected-points gain over what you would
# actually start instead; the percentage is a way of saying how hard that gain
# is worth chasing with a finite budget.
FAAB_BANDS = [
    (8.0, 0.30, 0.45, "clear starter upgrade at a position you're thin at"),
    (4.0, 0.15, 0.25, "starts for you most weeks"),
    (1.5, 0.05, 0.12, "marginal starter / good bench"),
    (0.0, 0.01, 0.04, "depth, stash, or a one-week bye fill"),
]


@dataclass
class WaiverTarget:
    player: WeeklyPlayer
    gain: float | None            # projected pts over who they'd replace
    replaces: WeeklyPlayer | None  # the starter they'd displace
    drop: WeeklyPlayer | None      # who to cut to make room
    rationale: str
    bid_low: int | None = None     # % of remaining FAAB
    bid_high: int | None = None
    worth_priority: bool = False   # for priority leagues
    note: str | None = None        # researched note from the board, if any


def _worst_startable(lineup: Lineup, pos: str) -> WeeklyPlayer | None:
    """The weakest player currently holding a slot this position could take —
    i.e. what a pickup at `pos` would actually be replacing."""
    candidates = [
        a.player for a in lineup.starters
        if a.player and slot_accepts(a.slot, pos)
    ]
    empty = [a for a in lineup.starters if a.player is None and slot_accepts(a.slot, pos)]
    if empty:
        return None  # an empty slot means the replacement level is zero
    if not candidates:
        return None
    return min(candidates, key=lambda p: (p.proj is None, p.proj or 0.0))


def evaluate_waiver_targets(
    available: list[WeeklyPlayer],
    roster: list[WeeklyPlayer],
    starters: dict,
    superflex: bool = False,
    faab_remaining: int | None = None,
    top: int = 10,
) -> list[WaiverTarget]:
    """Rank free agents by what they'd actually add to *this* lineup.

    A waiver claim is only worth what it upgrades. The best available player is
    not the right pickup if he'd sit behind two better ones at the same
    position, and a mediocre one is the right pickup if he fills a slot that is
    currently empty. So everything is measured against who you would otherwise
    start, not against the rest of the wire.
    """
    best = optimal_lineup(roster, starters, superflex=superflex)
    droppable = sorted(
        (p for p in roster if p.name not in best.named()),
        key=lambda p: (p.proj is None, p.proj or 0.0, p.name),
    )

    targets: list[WaiverTarget] = []
    for order, candidate in enumerate(available):
        if not candidate.playable:
            continue
        incumbent = _worst_startable(best, candidate.pos)

        if incumbent is None:
            gain = candidate.proj
            rationale = f"fills an empty {candidate.pos} slot"
        elif candidate.proj is None or incumbent.proj is None:
            gain = None
            rationale = f"no weekly projection — compare against {incumbent.name} yourself"
        else:
            gain = round(candidate.proj - incumbent.proj, 2)
            if gain <= 0:
                rationale = f"would sit behind {incumbent.name}; depth only"
            else:
                rationale = f"projects {gain:+.2f} over {incumbent.name}"

        target = WaiverTarget(
            player=candidate, gain=gain, replaces=incumbent,
            drop=droppable[0] if droppable else None, rationale=rationale,
        )
        _price(target, faab_remaining)
        targets.append((order, target))

    # Ties and unrankable candidates keep the order they arrived in. That
    # matters more than it looks: with no weekly projections every gain is
    # None, and falling back to the player's name would throw away the ADP
    # ordering the pool arrived in and rank the wire alphabetically.
    targets.sort(key=lambda pair: (pair[1].gain is None, -(pair[1].gain or 0.0), pair[0]))
    return [target for _, target in targets[:top]]


def _price(target: WaiverTarget, faab_remaining: int | None) -> None:
    """Attach a bid range and a priority verdict to a target."""
    gain = target.gain
    if gain is None:
        target.worth_priority = False
        return

    for threshold, low, high, label in FAAB_BANDS:
        if gain >= threshold:
            target.note = label
            if faab_remaining:
                target.bid_low = max(1, round(faab_remaining * low))
                target.bid_high = max(target.bid_low, round(faab_remaining * high))
            # Burning a numbered waiver priority drops you to last, so it is
            # only worth it for someone who starts beyond this single week.
            target.worth_priority = gain >= 4.0
            return


# --- Season calendar ----------------------------------------------------------

def current_week(config: dict, today: datetime.date | None = None) -> int | None:
    """Which NFL week it is, from `season.week1_start` in league.yaml.

    Returns None rather than guessing when the date isn't configured — a
    report that silently assumes the wrong week is how you set a Week 3
    lineup in Week 4.
    """
    season = (config or {}).get("season") or {}
    start = season.get("week1_start")
    if not start:
        return None
    if isinstance(start, str):
        try:
            start = datetime.date.fromisoformat(start)
        except ValueError:
            return None
    elif isinstance(start, datetime.datetime):
        start = start.date()
    elif not isinstance(start, datetime.date):
        return None

    today = today or datetime.date.today()
    days = (today - start).days
    if days < 0:
        return None
    return min(18, days // 7 + 1)


def week_label(config: dict, today: datetime.date | None = None) -> str:
    """A short heading that distinguishes the two reasons there is no week yet.

    "Before kickoff" and "nobody configured a season start" both come back as
    None from current_week(), and they call for different things from the
    reader — one is a date to wait for, the other is a line of YAML to fill in.
    So they must not collapse into the same "week unknown".
    """
    week = current_week(config, today)
    if week:
        return f"Week {week}"
    start = ((config or {}).get("season") or {}).get("week1_start")
    return f"Preseason (Week 1 kicks off {start})" if start else "Week unknown"


def waiver_system(config: dict) -> tuple[str, int | None]:
    """(system, faab_remaining). Defaults to FAAB, which is what most Yahoo
    leagues run — but the report says which it assumed, so a league on
    rolling priority notices immediately rather than acting on a bid."""
    waivers = (config or {}).get("waivers") or {}
    system = str(waivers.get("system") or "faab").lower()
    if system not in {"faab", "priority"}:
        system = "faab"
    remaining = waivers.get("faab_remaining")
    if remaining is None:
        remaining = waivers.get("faab_budget")
    try:
        remaining = int(remaining) if remaining is not None else None
    except (TypeError, ValueError):
        remaining = None
    return system, remaining


def bye_outlook(roster: list[WeeklyPlayer], bye_weeks: dict, week: int | None,
                starters: dict, weeks_ahead: int = 3) -> list[tuple[int, list[WeeklyPlayer]]]:
    """Upcoming weeks where byes would leave a starting slot short.

    Looks only as far as `weeks_ahead` because a bye pileup in Week 11 is not
    this week's problem, and a waiver claim made six weeks early is a roster
    spot wasted for six weeks.
    """
    if week is None:
        return []
    needed = defaultdict(int)
    for slot in expand_slots(starters):
        if slot in FLEX_SLOTS:
            continue
        needed[slot] += 1

    out: list[tuple[int, list[WeeklyPlayer]]] = []
    for ahead in range(1, weeks_ahead + 1):
        target_week = week + ahead
        on_bye = [p for p in roster if bye_weeks.get(p.team.upper()) == target_week]
        if not on_bye:
            continue
        by_pos = defaultdict(int)
        for p in on_bye:
            by_pos[p.pos] += 1
        available_after = {
            pos: len([p for p in roster if p.pos == pos]) - count
            for pos, count in by_pos.items()
        }
        short = [pos for pos, left in available_after.items() if left < needed.get(pos, 0)]
        if short:
            out.append((target_week, [p for p in on_bye if p.pos in short]))
    return out
