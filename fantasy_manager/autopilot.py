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
    avail = [p for p in players if p.drafted_by is None]
    if not avail:
        return None

    picks_made = sum(1 for p in players if p.drafted_by is not None)
    scores = score_players(players, config, picks_made)
    # A roster is played weekly, not drafted once: two starters at one
    # position sharing a bye means a week without that position, and ADP
    # ranks players in isolation. Applied to every path below, so even a
    # forced need pick prefers the candidate who doesn't empty the same week.
    for p in avail:
        scores[p.name] += bye_penalty(p, mine, config)

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
    if not (core_filled or late_enough):
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
