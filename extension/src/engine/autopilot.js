/*
 * Full-autopilot pick engine — a faithful port of fantasy_manager/autopilot.py.
 * Same scoring, same four guardrails, same priority order. This is the piece
 * that actually decides what to draft, so it is verified against the Python
 * original by extension/test/compare_with_python.js rather than trusted by
 * inspection alone.
 */
import { replacementRanks } from "./board.js";

export const RISK_MULTIPLIERS = {
  safe_floor: [1.5, 0.5],
  balanced: [1.0, 1.0],
  chase_upside: [0.5, 1.5],
};

// Early-round position bias for robust_rb / zero_rb, tapering off as the
// draft progresses.
export const STRATEGY_TAPER_PICKS = 60;

/* In ADP points: enough to break a tie between similar players, not enough to
 * pass over a clearly better one. A bye clash costs you one week; reaching for
 * a worse player costs you the season. */
export const DEFAULT_BYE_PENALTY = 6.0;

function strategyBias(pos, strategy, picksMade) {
  if (strategy === "best_player_available" || picksMade >= STRATEGY_TAPER_PICKS) return 0.0;
  const taper = 1 - picksMade / STRATEGY_TAPER_PICKS;
  if (strategy === "robust_rb" && pos === "RB") return -8.0 * taper;
  if (strategy === "zero_rb" && pos === "RB") return 10.0 * taper;
  if (strategy === "zero_rb" && (pos === "WR" || pos === "TE")) return -4.0 * taper;
  return 0.0;
}

/** Effective adjustedAdp per player name, after risk-tolerance scaling and
 * strategy bias — lower is better, same units as ADP (picks). */
export function scorePlayers(players, config, picksMade) {
  const ap = config.autopilot || {};
  const strategy = ap.strategy || "best_player_available";
  const risk = ap.risk_tolerance || "balanced";
  const [bustMult, breakoutMult] = RISK_MULTIPLIERS[risk] || [1.0, 1.0];

  const scores = {};
  for (const p of players) {
    let adj;
    if (p.adjustment > 0) adj = p.adjustment * bustMult; // bust / injury_watch / value_note
    else if (p.adjustment < 0) adj = p.adjustment * breakoutMult; // breakout
    else adj = 0.0;
    scores[p.name] = p.adp + adj + strategyBias(p.pos, strategy, picksMade);
  }
  return scores;
}

function minBy(list, keyFn) {
  let best = list[0];
  let bestKey = keyFn(best);
  for (let i = 1; i < list.length; i++) {
    const k = keyFn(list[i]);
    if (k < bestKey) {
      best = list[i];
      bestKey = k;
    }
  }
  return best;
}

/* A roster is played weekly, not drafted once. Two starting RBs on the same
 * bye means a week with no RBs, and ADP knows nothing about that — it ranks
 * players in isolation. So a candidate is penalised for each player already
 * rostered at his position who shares his bye.
 *
 * Only when byes are actually known: fixtures without team bye data get no
 * penalty, so this cannot silently change the engine where it can't see. */
export function byePenalty(player, mine, config) {
  const weight = config.autopilot?.bye_penalty ?? DEFAULT_BYE_PENALTY;
  if (!weight || !player.bye) return 0;
  const clashes = mine.filter((p) => p.pos === player.pos && p.bye === player.bye).length;
  return clashes * weight;
}

/**
 * @returns {{player, score, reason, needOverride}|null}
 */
export function autoPick(players, config) {
  const mine = players.filter((p) => p.draftedBy === "mine");
  const avail = players.filter((p) => !p.draftedBy);
  if (avail.length === 0) return null;

  const picksMade = players.filter((p) => p.draftedBy).length;
  const scores = scorePlayers(players, config, picksMade);
  // Applied to every path below — a forced need pick should still prefer the
  // candidate who doesn't leave that position empty on the same week.
  for (const p of avail) scores[p.name] += byePenalty(p, mine, config);

  const starters = config.roster.starters;
  const benchCap = (config.autopilot || {}).max_bench_per_pos ?? 3;
  const have = {};
  for (const pos of Object.keys(starters)) {
    have[pos] = mine.filter((p) => p.pos === pos).length;
  }
  const totalStarters = Object.entries(starters)
    .filter(([pos]) => pos !== "FLEX")
    .reduce((sum, [, n]) => sum + n, 0);

  // --- Guardrail 1: don't draft K/DEF until every other starter slot has
  // at least one player, unless we're deep enough that it's actually time.
  const corePositions = Object.keys(starters).filter((pos) => !["K", "DEF", "FLEX"].includes(pos));
  const coreFilled = corePositions.every((pos) => (have[pos] || 0) >= starters[pos]);
  const lateEnough = Math.floor(picksMade / config.league.num_teams) >= totalStarters - 1;

  let pool = avail;
  if (!(coreFilled || lateEnough)) {
    pool = pool.filter((p) => p.pos !== "K" && p.pos !== "DEF");
  }

  // --- Guardrail 2: don't overdraft bench depth at one position.
  const rosteredCount = (pos) => mine.filter((p) => p.pos === pos).length;

  // Bench allowance only applies to positions this league actually starts.
  // A position absent from starters (no K slot) gets cap 0 — no reason to
  // roster a player who can never be started.
  const capPerPos = {};
  for (const pos of ["QB", "RB", "WR", "TE", "K", "DEF"]) {
    if ((starters[pos] || 0) > 0) capPerPos[pos] = starters[pos] + benchCap;
  }
  pool = pool.filter((p) => rosteredCount(p.pos) < (capPerPos[p.pos] ?? 0));

  if (pool.length === 0) pool = avail; // guardrails ate the whole pool — fail open

  // --- Guardrail 3 (highest priority): don't let the draft end with an
  // empty starter slot. IR is deliberately excluded from draftable spots —
  // it's filled from waivers, not drafted, so counting it would delay this
  // override past the final pick.
  const rosterCfg = config.roster;
  const draftableSpots =
    Object.values(starters).reduce((a, b) => a + b, 0) + (rosterCfg.bench || 0);
  const myPicksRemaining = draftableSpots - mine.length;
  const allPositions = Object.keys(starters).filter((pos) => pos !== "FLEX");
  const unfilledStarters = allPositions.filter((pos) => (have[pos] || 0) < starters[pos]);

  // Strictly positive: at zero or below the configured roster is already
  // full, and "no picks left, so spend one on a kicker" is a contradiction —
  // it means the league config doesn't describe this draft.
  if (unfilledStarters.length > 0 && myPicksRemaining > 0 &&
      myPicksRemaining <= unfilledStarters.length) {
    const candidates = avail.filter((p) => unfilledStarters.includes(p.pos));
    if (candidates.length > 0) {
      const replNow = replacementRanks(config);
      const draftedNow = {};
      for (const pos of Object.keys(replNow)) {
        draftedNow[pos] = players.filter((p) => p.pos === pos && p.draftedBy).length;
      }
      const mostUrgentPos = minBy(
        unfilledStarters,
        (pos) => (replNow[pos] ?? 999) - (draftedNow[pos] ?? 0)
      );
      const posCandidates = candidates.filter((p) => p.pos === mostUrgentPos);
      const finalCandidates = posCandidates.length > 0 ? posCandidates : candidates;
      const best = minBy(finalCandidates, (p) => scores[p.name]);
      const reason =
        `Roster-completion override: only ${myPicksRemaining} pick(s) left and ` +
        `${unfilledStarters.join(", ")} still unfilled — can't afford to punt this any further.`;
      return { player: best, score: scores[best.name], reason, needOverride: true };
    }
  }

  // --- Guardrail 4: force a need pick if a starting slot is empty AND the
  // position is about to run dry league-wide (replacement cliff).
  const repl = replacementRanks(config);
  const draftedAtPos = {};
  for (const pos of Object.keys(repl)) {
    draftedAtPos[pos] = players.filter((p) => p.pos === pos && p.draftedBy).length;
  }
  const urgentNeeds = corePositions.filter(
    (pos) => (have[pos] || 0) < starters[pos] && repl[pos] - (draftedAtPos[pos] || 0) <= 3
  );

  if (urgentNeeds.length > 0) {
    const candidates = pool.filter((p) => urgentNeeds.includes(p.pos));
    if (candidates.length > 0) {
      const best = minBy(candidates, (p) => scores[p.name]);
      // State the real count. "None rostered" was hardcoded, so a roster with
      // one of two starters filled was told it had none — which reads as the
      // engine having ignored the pick you just made, and is the fastest way
      // to lose trust in advice that is actually correct.
      const reason =
        `Need override: ${best.pos} is ${repl[best.pos] - (draftedAtPos[best.pos] || 0)} ` +
        `picks from the replacement cliff league-wide and you have ` +
        `${have[best.pos] || 0} of ${starters[best.pos] || 0} rostered.`;
      return { player: best, score: scores[best.name], reason, needOverride: true };
    }
  }

  // --- Otherwise: best player available by adjusted score.
  const best = minBy(pool, (p) => scores[p.name]);
  const bits = [
    `Best available by adjusted value (raw ADP ${best.adp}, adjusted ${scores[best.name].toFixed(1)}).`,
  ];
  if (best.note) bits.push(`${best.noteTag}: ${best.note}`);
  return { player: best, score: scores[best.name], reason: bits.join(" "), needOverride: false };
}

/* An ordered shortlist for the draft room's own queue, by greedy rollout:
 * take the pick, treat that player as gone, ask again.
 *
 * "Gone", deliberately — not "mine". A queue is a fallback chain for one
 * pick ("if he's sniped, then who?"), not a plan to acquire all five. Marking
 * them as ours would fill imaginary roster slots and skew every subsequent
 * answer toward positions we hadn't actually drafted.
 *
 * Nothing here is persisted: draftedBy is mutated on the working copy and put
 * back, so callers can run this against live state without disturbing it.
 */
export function topPicks(players, config, n = 5) {
  const chosen = [];
  const touched = [];
  try {
    for (let i = 0; i < n; i++) {
      const decision = autoPick(players, config);
      if (!decision) break;
      const player = decision.player;
      chosen.push({
        name: player.name,
        pos: player.pos,
        team: player.team,
        tier: player.tier,
        reason: decision.reason,
        needOverride: decision.needOverride,
      });
      player.draftedBy = "rival";
      touched.push(player);
    }
  } finally {
    for (const player of touched) player.draftedBy = null;
  }
  return chosen;
}
