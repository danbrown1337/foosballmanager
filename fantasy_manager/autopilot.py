"""
Full-autopilot pick engine.

Combines the market signal (ADP, tiered) with researched risk/upside
adjustments (data/player_notes_2026.csv — bust concerns, injury watches,
breakout cases sourced from beat-writer/analyst coverage just before the
2026 season) into a single ranking, then applies need-aware guardrails so
"best player available" doesn't do something dumb like draft a 3rd K.

Config-driven (config/league.yaml -> autopilot:):
  strategy: best_player_available | robust_rb | zero_rb
  risk_tolerance: safe_floor | balanced | chase_upside

This is the same engine draft_assistant.py's `recommend` command surfaces
to a human; `auto_pick()` is the version that returns one committed
decision with its full reasoning, for the confirm-and-go / full-autopilot
flows once the live draft room can be read via the browser.
"""
from __future__ import annotations

from dataclasses import dataclass

from fantasy_manager.board import Player, replacement_ranks

RISK_MULTIPLIERS = {
    # (bust/injury penalty multiplier, breakout bonus multiplier)
    "safe_floor": (1.5, 0.5),
    "balanced": (1.0, 1.0),
    "chase_upside": (0.5, 1.5),
}

# Early-round position bias for robust_rb / zero_rb, tapering off as the
# draft progresses. Expressed as an adjusted_adp discount/penalty in
# "picks", scaled down as total picks made grows past this many.
STRATEGY_TAPER_PICKS = 60


def _strategy_bias(pos: str, strategy: str, picks_made: int) -> float:
    if strategy == "best_player_available" or picks_made >= STRATEGY_TAPER_PICKS:
        return 0.0
    taper = 1 - (picks_made / STRATEGY_TAPER_PICKS)
    if strategy == "robust_rb" and pos == "RB":
        return -8.0 * taper  # pulls RB earlier
    if strategy == "zero_rb" and pos == "RB":
        return 10.0 * taper  # pushes RB later
    if strategy == "zero_rb" and pos in ("WR", "TE"):
        return -4.0 * taper  # small pull toward WR/TE
    return 0.0


DEFAULT_BYE_PENALTY = 6.0

# Cost of a player at a position whose starting slots are already filled.
# Heavier where the position has nowhere else to play: a second QB, kicker or
# defence sits on the bench all season, while a third back or receiver still
# starts in the flex or covers a bye.
# Designations meaning the player will not play this season. Drafting one
# spends a roster spot on nobody, so they are removed from consideration
# entirely — the same treatment a position the league doesn't start gets.
# NA is Yahoo's "Not Active". CEL is the NFL's Commissioner Exempt List —
# paid leave during a legal or league investigation, so neither injured nor
# suspended, but no practice and no return date. DNR is "Did Not Report".
UNAVAILABLE = {"IR", "IR-R", "PUP-R", "NFI-R", "SUSP", "O", "NA", "CEL", "DNR"}

SURPLUS_PENALTY = {"QB": 14, "K": 20, "DEF": 20, "TE": 8, "RB": 3, "WR": 3}

# How many of each position a full roster wants beyond its starters. A bench
# exists to cover byes and injuries at the positions played every week; without
# saying so, a bench filled with receivers left two running backs on a roster
# that starts two and a flex, with no cover for their byes. And nothing stopped
# a second kicker, which cannot be played and cannot be needed.
# Bench spots wanted beyond the starters, by position. Revised after a
# 15-round mock came back with a second quarterback and a second tight end on
# the bench and one every-week running back. In a one-QB league a QB2 never
# starts; behind a top-two tight end a TE2 never starts either. Both cost a
# round while the backfield went unaddressed. A league that starts two
# quarterbacks says so in roster.starters, and this counts on top of that.
DEPTH_TARGET = {"RB": 3, "WR": 2, "TE": 0, "QB": 0, "K": 0, "DEF": 0}

# Beyond the target the charge stops being a nudge.
BEYOND_DEPTH_PENALTY = 60.0


# Positions a W/R/T flex can start. The flex absorbs exactly one spare across
# all of them — not one each, which is how a roster reached three tight ends:
# each looked like it was filling the same empty flex.
FLEX_ELIGIBLE = {"RB", "WR", "TE"}


FLEX_CLAIMS = frozenset({"RB", "WR"})


def surplus_penalty(player, mine, config):
    """Cost of stacking a position whose starters are already filled."""
    starters = config["roster"]["starters"]
    need = starters.get(player.pos, 0)
    have = sum(1 for p in mine if p.pos == player.pos)
    if have < need:
        return 0.0

    surplus = have - need + 1
    flex_slots = starters.get("FLEX", 0)
    # A W/R/T flex will take a tight end, and letting one claim the slot for
    # free is how a second tight end reached a bench behind the second-best
    # tight end in the draft. Legal, and nearly always the worst use of the
    # slot in PPR, so only the positions that would really start there claim
    # the discount.
    if player.pos in FLEX_CLAIMS and flex_slots > 0:
        spares = sum(
            max(0, sum(1 for p in mine if p.pos == pos) - starters.get(pos, 0))
            for pos in starters
            if pos in FLEX_ELIGIBLE
        )
        if spares < flex_slots:
            surplus -= 1  # this one starts in the flex
    if surplus <= 0:
        return 0.0

    # Past the depth this roster wants, the player is bench filler at a
    # position already covered, and the spot is one not spent covering a bye.
    targets = config.get("autopilot", {}).get("depth_target", DEPTH_TARGET)
    extra = targets.get(player.pos, 1)
    if have >= need + extra:
        return BEYOND_DEPTH_PENALTY * (have - need - extra + 1)

    weights = config.get("autopilot", {}).get("surplus_penalty", SURPLUS_PENALTY)
    # Squared: a second spare is a nudge, a third is a wall. A flat charge was
    # cleared by any player ranked a little higher, twice over.
    return surplus * surplus * weights.get(player.pos, 5)


# A board ADP that is really list position, before the room has been read
# widely enough to prove the player has no ADP at all. Excluding him on that
# suspicion alone would repeat the mistake that left a kicker slot empty
# twice; pushing him down keeps him out of the middle rounds while leaving him
# available at the end, when the alternative is an empty roster spot.
GUESSED_ADP_PENALTY = 50.0


# A player sitting behind a clearly better player of his own position on his
# own NFL team. A draft came back with three of its four backs being other
# managers' handcuffs — Lloyd behind Jacobs, Rodriguez behind Tuten, Brian
# Robinson behind Bijan. ADP prices those players for the chance the starter
# gets hurt, and the engine kept buying that chance without owning the thing
# it insures. No depth chart is needed: a much better ADP at the same position
# on the same team is what a backup looks like from here, and two rounds is
# the gap — closer than that is a committee, where both play. The charge is by
# position, because a second back or quarterback plays only on an injury while
# a team's second and third receivers play every week.
BACKUP_ADP_GAP = 24.0
BACKUP_PENALTY = {"QB": 30.0, "RB": 25.0, "TE": 12.0, "WR": 4.0}


def backup_penalty(player, mine, players, config):
    weights = config.get("autopilot", {}).get("backup_penalty", BACKUP_PENALTY)
    weight = weights.get(player.pos, 0.0)
    if not weight or not player.team:
        return 0.0

    ahead = [
        p for p in players
        if p.pos == player.pos and p.team == player.team and p.name != player.name
        and player.adp - p.adp >= BACKUP_ADP_GAP
    ]
    if not ahead:
        return 0.0

    # Handcuffing your own starter is the point of a handcuff: the insurance
    # pays out to you. Handcuffing somebody else's is a bet on an injury that
    # helps you only if you then win the bidding war for the job.
    mine_names = {p.name for p in mine}
    if any(p.name in mine_names for p in ahead):
        return 0.0
    return weight


def guess_penalty(player, config):
    if getattr(player, "adp_source", None) != "rank":
        return 0.0
    return config.get("autopilot", {}).get("guessed_adp_penalty", GUESSED_ADP_PENALTY)


# The cost of not having filled a starting slot yet, rising as the draft goes
# on. A mock reached round 6 with no running backs and never repaired it:
# need was a cliff, firing only once a position was within a few players of
# running dry league-wide, by which point the good ones are gone. Wanting a
# back in round 4 and needing one in round 6 scored identically.
#
# A gradient, not a rule. Nothing here says "take a back by round 5", the cap
# is no larger than one clear tier so an elite player elsewhere still wins,
# and rounds one and two are untouched. Per position, because a missing back
# is the expensive hole — replacement backs are the worst on waivers — while
# receivers are deep enough that waiting costs less.
NEED_START_ROUND = 3
NEED_ESCALATION = {"RB": 12.0, "WR": 8.0, "TE": 6.0, "QB": 6.0, "K": 0.0, "DEF": 0.0}
NEED_CAP = 60.0


def draftable_spots_for(config):
    """Every slot a draft actually fills: the starters plus the bench."""
    starters = config["roster"]["starters"]
    return sum(starters.values()) + config["roster"].get("bench", 0)


def need_bonus(player, mine, config, picks_made):
    starters = config["roster"]["starters"]
    need = starters.get(player.pos, 0)
    have = sum(1 for p in mine if p.pos == player.pos)
    if have >= need:
        return 0.0  # the slot is filled; surplus_penalty takes over

    ap = config.get("autopilot", {})
    teams = config["league"]["num_teams"]
    round_now = picks_made // teams + 1
    elapsed = round_now - ap.get("need_start_round", NEED_START_ROUND)
    if elapsed < 0:
        return 0.0

    step = ap.get("need_escalation", NEED_ESCALATION).get(player.pos, 0.0)
    if not step:
        return 0.0

    # elapsed + 1 so the round it switches on is worth something, not zero.
    pull = step * (elapsed + 1) * (need - have)
    return -min(pull, ap.get("need_cap", NEED_CAP))  # negative: lower is better


# How much less sure to be about a player his sources disagree about.
# MarShawn Lloyd was 69th on one fresh board and 117th on another two days
# later, while the back ahead of him had a court date move forward and stayed
# on the commissioner's exempt list. Neither board is wrong; his role is
# unsettled, and averaging 69 and 117 into 93 hides the thing worth knowing.
# The charge is small on purpose: it decides between players who are otherwise
# close, and a contested player can still be the right pick.
DISPERSION_BANDS = ((36, 20.0), (21, 10.0), (11, 4.0))


def dispersion_penalty(player, config):
    spread = getattr(player, "adp_spread", 0) or 0
    bands = config.get("autopilot", {}).get("dispersion_bands", DISPERSION_BANDS)
    for floor, weight in bands:
        if spread >= floor:
            return weight
    return 0.0


# What is actually lost by waiting one more player at this position. A rank
# difference of one or two inside a tier is noise; the gap between the last
# player of a strong tier and the first of the next is the whole decision. The
# draft room publishes projected points per player, so this is a measurement
# rather than an inference. A missing projection means no information, and the
# rule contributes nothing rather than guessing.
CLIFF_PLACES_PER_POINT = 0.5
CLIFF_CAP = 30.0


def tier_cliff_bonus(player, players, config):
    proj = getattr(player, "proj", None)
    if not isinstance(proj, (int, float)):
        return 0.0
    ap = config.get("autopilot", {})
    rate = ap.get("cliff_places_per_point", CLIFF_PLACES_PER_POINT)
    cap = ap.get("cliff_cap", CLIFF_CAP)

    later = [
        p for p in players
        if p.pos == player.pos and not p.drafted_by and p.name != player.name
        and isinstance(getattr(p, "proj", None), (int, float)) and p.adp > player.adp
    ]
    if not later:
        return 0.0
    next_up = min(later, key=lambda p: p.adp)

    drop = proj - next_up.proj
    if drop <= 0:
        return 0.0  # the next man up is as good; nothing is lost by waiting
    return -min(drop * rate, cap)  # negative: a cliff pulls him forward


# Whether this position can wait until the next turn. Raw ADP already answers
# "who is best", so scoring a player by his own chance of surviving would only
# restate it. What ADP order does not say is what happens to the position: if
# the next comparable back is gone before your next pick too, waiting costs
# you the tier; if he will still be sitting there, waiting costs nothing.
# Pairs with the tier cliff, which measures how much is lost — this measures
# how likely you are to lose it, and stays small because both are estimates
# built on a market average.
URGENCY_BONUS = 6.0
PATIENCE_PENALTY = 4.0


def urgency_bonus(player, players, config, picks_made):
    ap = config.get("autopilot", {})
    window = ap.get("picks_until_turn")
    if not isinstance(window, (int, float)) or window <= 0:
        return 0.0  # no turn context

    later = [
        p for p in players
        if p.pos == player.pos and not p.drafted_by and p.name != player.name
        and p.adp > player.adp
    ]
    if not later:
        return -ap.get("urgency_bonus", URGENCY_BONUS)  # last of his kind
    next_up = min(later, key=lambda p: p.adp)

    deadline = picks_made + 1 + window
    if next_up.adp <= deadline:
        return -ap.get("urgency_bonus", URGENCY_BONUS)  # his replacement goes too
    return ap.get("patience_penalty", PATIENCE_PENALTY)  # the position keeps


def bye_penalty(player, mine, config):
    """Cost of stacking this player's bye with players already rostered.

    In ADP points, and only where byes are known: a player with no bye data
    is treated as unknown rather than clash-free, so this never silently
    changes behaviour where it cannot see.
    """
    weight = config.get("autopilot", {}).get("bye_penalty", DEFAULT_BYE_PENALTY)
    bye = getattr(player, "bye", None)
    if not weight or not bye:
        return 0.0
    clashes = sum(1 for p in mine if p.pos == player.pos and getattr(p, "bye", None) == bye)
    return clashes * weight


def score_players(players: list[Player], config: dict, picks_made: int) -> dict[str, float]:
    """Effective adjusted_adp per player name, after risk-tolerance scaling
    and strategy bias — lower is better, same units as ADP (picks)."""
    ap = config.get("autopilot", {})
    strategy = ap.get("strategy", "best_player_available")
    risk = ap.get("risk_tolerance", "balanced")
    bust_mult, breakout_mult = RISK_MULTIPLIERS.get(risk, (1.0, 1.0))

    scores = {}
    for p in players:
        if p.adjustment > 0:  # bust / injury_watch / value_note
            adj = p.adjustment * bust_mult
        elif p.adjustment < 0:  # breakout
            adj = p.adjustment * breakout_mult
        else:
            adj = 0.0
        scores[p.name] = p.adp + adj + _strategy_bias(p.pos, strategy, picks_made)
    return scores


@dataclass
class PickDecision:
    player: Player
    score: float
    reason: str
    need_override: bool


def auto_pick(players: list[Player], config: dict) -> PickDecision | None:
    mine = [p for p in players if p.drafted_by == "mine"]
    avail = [
        p for p in players
        if p.drafted_by is None
        and getattr(p, "status", None) not in UNAVAILABLE
        and not getattr(p, "undrafted", False)
    ]
    if not avail:
        return None

    picks_made = sum(1 for p in players if p.drafted_by is not None)
    scores = score_players(players, config, picks_made)
    # A roster is played weekly, not drafted once: two starters at one
    # position sharing a bye means a week without that position, and ADP
    # ranks players in isolation. Applied to every path below, so even a
    # forced need pick prefers the candidate who doesn't empty the same week.
    for p in avail:
        scores[p.name] += (
            bye_penalty(p, mine, config)
            + surplus_penalty(p, mine, config)
            + guess_penalty(p, config)
            + backup_penalty(p, mine, players, config)
            + need_bonus(p, mine, config, picks_made)
            + dispersion_penalty(p, config)
            + tier_cliff_bonus(p, players, config)
            + urgency_bonus(p, players, config, picks_made)
        )

    starters = config["roster"]["starters"]
    bench_cap = config.get("autopilot", {}).get("max_bench_per_pos", 3)
    have = {pos: sum(1 for p in mine if p.pos == pos) for pos in starters}
    total_starters = sum(n for pos, n in starters.items() if pos != "FLEX")

    # --- Guardrail 1: don't draft K/DEF until every other starter slot has
    # at least one player, unless we're deep enough that it's actually time.
    core_positions = [pos for pos in starters if pos not in ("K", "DEF", "FLEX")]
    core_filled = all(have.get(pos, 0) >= starters[pos] for pos in core_positions)
    # "Late enough" = we're at least (total starters - 1) rounds into the draft.
    late_enough = (picks_made // config["league"]["num_teams"]) >= (total_starters - 1)

    pool = avail
    # And a hard floor besides. Core-slots-filled releases kickers around round
    # eight in a nine-starter league, and only ADP has kept them later — a
    # kicker priced at 87 beats a receiver at 95 on the board, which spends a
    # bench spot on a position whose replacement is free all season. The floor
    # is the last two rounds of the roster, whatever its size; the
    # roster-completion override below reads the unfiltered pool, so a draft
    # that reaches its end still fills the slot.
    round_now = picks_made // config["league"]["num_teams"] + 1
    onesie_floor = config.get("autopilot", {}).get(
        "onesie_min_round", max(1, draftable_spots_for(config) - 1)
    )
    if not (core_filled or late_enough) or round_now < onesie_floor:
        pool = [p for p in pool if p.pos not in ("K", "DEF")]

    # --- Guardrail 2: don't overdraft bench depth at one position.
    def rostered_count(pos):
        return sum(1 for p in mine if p.pos == pos)

    # Bench allowance only applies to positions this league actually starts.
    # A position absent from starters (e.g. no K slot) gets cap 0 — there is
    # no reason to roster a player who can never be started, and without this
    # a league that doesn't use kickers would still let autopilot burn bench
    # spots on them once skill-position value ran out.
    cap_per_pos = {
        pos: starters.get(pos, 0) + bench_cap
        for pos in ["QB", "RB", "WR", "TE", "K", "DEF"]
        if starters.get(pos, 0) > 0
    }
    pool = [p for p in pool if rostered_count(p.pos) < cap_per_pos.get(p.pos, 0)]

    if not pool:
        pool = avail  # guardrails ate the whole pool (shouldn't normally happen) — fail open

    # --- Guardrail 3 (highest priority): don't let the draft end with an
    # empty starter slot. Once the number of picks you have left equals
    # the number of still-unfilled starter positions (K/DEF included),
    # every remaining pick MUST go toward one of those, full stop —
    # otherwise BPA can happily punt K/DEF into a bench spot that never
    # comes and you show up to Week 1 short a starter.
    roster_cfg = config["roster"]
    # IR is deliberately excluded: it's filled from waivers during the season,
    # not drafted, so counting it would overstate how many picks are left and
    # delay this override past the final pick — exactly the case it exists for.
    draftable_spots = sum(starters.values()) + roster_cfg.get("bench", 0)
    my_picks_remaining = draftable_spots - len(mine)
    all_positions = [pos for pos in starters if pos != "FLEX"]
    unfilled_starters = [pos for pos in all_positions if have.get(pos, 0) < starters[pos]]

    # Strictly positive: at zero or below, the configured roster is already
    # full, and "you have no picks left, so spend a pick on a kicker" is a
    # contradiction. It means the league config doesn't describe this draft —
    # a three-slot config in a fifteen-slot room forced a round-one kicker in
    # testing — and forcing a pick on those numbers makes it worse, not safer.
    if unfilled_starters and 0 < my_picks_remaining <= len(unfilled_starters):
        candidates = [p for p in avail if p.pos in unfilled_starters]
        if candidates:
            # Fill whichever unfilled position is scarcest league-wide first.
            repl_now = replacement_ranks(config)
            drafted_now = {pos: sum(1 for p in players if p.pos == pos and p.drafted_by is not None)
                            for pos in repl_now}
            most_urgent_pos = min(
                unfilled_starters,
                key=lambda pos: repl_now.get(pos, 999) - drafted_now.get(pos, 0),
            )
            pos_candidates = [p for p in candidates if p.pos == most_urgent_pos] or candidates
            best = min(pos_candidates, key=lambda p: scores[p.name])
            reason = (
                f"Roster-completion override: only {my_picks_remaining} pick(s) left and "
                f"{', '.join(unfilled_starters)} still unfilled — can't afford to punt this any further."
            )
            return PickDecision(best, scores[best.name], reason, need_override=True)

    # --- Guardrail 4: force a need pick if a starting slot is empty AND
    # the position is about to run dry league-wide (replacement cliff).
    repl = replacement_ranks(config)
    drafted_at_pos = {pos: sum(1 for p in players if p.pos == pos and p.drafted_by is not None)
                       for pos in repl}
    urgent_needs = [
        pos for pos in core_positions
        if have.get(pos, 0) < starters[pos] and (repl[pos] - drafted_at_pos.get(pos, 0)) <= 3
    ]

    if urgent_needs:
        candidates = [p for p in pool if p.pos in urgent_needs]
        if candidates:
            best = min(candidates, key=lambda p: scores[p.name])
            # State the real count: "none rostered" was hardcoded, so a
            # roster with one of two starters filled was told it had none,
            # which reads as the engine ignoring the pick you just made.
            reason = (
                f"Need override: {best.pos} is {repl[best.pos] - drafted_at_pos.get(best.pos, 0)} "
                f"picks from the replacement cliff league-wide and you have "
                f"{have.get(best.pos, 0)} of {starters.get(best.pos, 0)} rostered."
            )
            return PickDecision(best, scores[best.name], reason, need_override=True)

    # --- Otherwise: best player available by adjusted score.
    best = min(pool, key=lambda p: scores[p.name])
    bits = [f"Best available by adjusted value (raw ADP {best.adp}, adjusted {scores[best.name]:.1f})."]
    if best.note:
        bits.append(f"{best.note_tag}: {best.note}")
    return PickDecision(best, scores[best.name], " ".join(bits), need_override=False)
