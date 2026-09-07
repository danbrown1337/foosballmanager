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

/* Cost of a player at a position whose starting slots are already filled.
 * Heavier where the position has nowhere else to play: a second QB, kicker or
 * defence sits on the bench all season, while a third RB or receiver still
 * starts in the flex or covers a bye. Without this the shortlist happily
 * offered three tight ends to a roster that starts one. */
/* Designations that mean the player will not play this season. Drafting one
 * spends a roster spot on nobody — so they are removed from consideration
 * entirely, the same treatment a position the league doesn't start gets. */
export const UNAVAILABLE = new Set([
  "IR", "IR-R", "PUP-R", "NFI-R", "SUSP", "O",
  // NA is Yahoo's "Not Active". Two were queued before this was here.
  "NA",
  // CEL is the NFL's Commissioner Exempt List — paid leave during a legal or
  // league investigation. Not injured, not suspended, so nothing else here
  // catches it, but the player does not practise and has no return date.
  "CEL",
  // DNR is "Did Not Report": under contract, never turned up.
  "DNR",
]);

export const SURPLUS_PENALTY = { QB: 14, K: 20, DEF: 20, TE: 8, RB: 3, WR: 3 };

/* How many of each position a full roster wants, over and above its starters.
 *
 * A bench exists to cover byes and injuries at the positions you start every
 * week. Without saying so, the engine filled a bench with receivers and left
 * two running backs on a roster that starts two and a flex — no cover at all
 * for their bye weeks. And nothing stopped a second kicker, which cannot be
 * played and cannot be needed.
 */
/* Bench spots wanted beyond the starters, by position.
 *
 * Revised after a 15-round mock came back with a second quarterback and a
 * second tight end on the bench and only one every-week running back. In a
 * one-quarterback league a QB2 never starts; behind a top-two tight end a TE2
 * never starts either. Both were costing a round each while the backfield
 * went unaddressed, so both targets are zero and the round goes to a back —
 * the position where injuries and byes actually leave a lineup short, and the
 * one whose waiver replacements are worst.
 *
 * A league that starts two quarterbacks says so in roster.starters, and this
 * is counted on top of that, so superflex formats are unaffected. */
export const DEPTH_TARGET = { RB: 3, WR: 2, TE: 0, QB: 0, K: 0, DEF: 0 };

/* Beyond the target the charge stops being a nudge. A third quarterback or a
 * second kicker is a wasted roster spot in any week of the season. */
export const BEYOND_DEPTH_PENALTY = 60;

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

const round1 = (n) => Math.round(n * 10) / 10;

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
/* Positions a W/R/T flex can start. The flex absorbs exactly one spare across
 * all of them — not one each, which is how a roster ended up with three tight
 * ends: each looked like it was filling the same empty flex. */
const FLEX_ELIGIBLE = new Set(["RB", "WR", "TE"]);
const FLEX_CLAIMS = new Set(["RB", "WR"]);

export function surplusPenalty(player, mine, config) {
  const starters = config.roster?.starters || {};
  const need = starters[player.pos] || 0;
  const have = mine.filter((p) => p.pos === player.pos).length;
  if (have < need) return 0; // still filling the position

  let surplus = have - need + 1; // this player would be the nth spare
  /* Who may claim the flex as "he starts there".
   *
   * A W/R/T flex will accept a tight end, and the engine used to let one
   * claim the slot and walk away with no charge at all — which is how a
   * second tight end landed on a roster behind the second-best tight end in
   * the draft. It is legal and it is nearly always the worst use of the slot
   * in PPR, where a third back or receiver plays more and scores more. So the
   * discount is for the positions that would really start there. */
  if (FLEX_CLAIMS.has(player.pos) && (starters.FLEX || 0) > 0) {
    const spares = Object.keys(starters)
      .filter((pos) => FLEX_ELIGIBLE.has(pos))
      .reduce((sum, pos) => sum + Math.max(0, mine.filter((p) => p.pos === pos).length - (starters[pos] || 0)), 0);
    if (spares < (starters.FLEX || 0)) surplus -= 1; // this one starts in the flex
  }
  if (surplus <= 0) return 0;

  /* Past the depth this roster wants, the player is bench filler at a
   * position already covered — and every one of those spots is one not spent
   * covering a bye at a position played weekly. */
  const targets = config.autopilot?.depth_target ?? DEPTH_TARGET;
  const extra = targets[player.pos] ?? 1;
  if (have >= need + extra) return BEYOND_DEPTH_PENALTY * (have - need - extra + 1);

  const weight = config.autopilot?.surplus_penalty?.[player.pos] ?? SURPLUS_PENALTY[player.pos] ?? 5;
  /* Squared, so a second spare is a nudge and a third is a wall. A linear
   * charge of 8 points for a second tight end was cleared by any player
   * ranked a little higher, and then so was the third. */
  return surplus * surplus * weight;
}

/* A board ADP that is really list position, before the room has been read
 * widely enough to prove the player has no ADP at all.
 *
 * Excluding him on that suspicion alone would repeat the mistake that left a
 * kicker slot empty twice — the imported pool simply lacks numbers for a long
 * tail of players, some of whom are perfectly ordinary picks. Pushing him
 * down the board instead keeps him out of the middle rounds, where a D-graded
 * receiver at list position 113 came from, while leaving him available at the
 * end when the alternative is an empty roster spot. */
export const GUESSED_ADP_PENALTY = 50;

/* A player who sits behind a clearly better player of his own position on his
 * own NFL team.
 *
 * A draft came back with three of its four running backs being other
 * managers' handcuffs: Lloyd behind Jacobs, Rodriguez behind Tuten, Brian
 * Robinson behind Bijan. ADP prices those players for the chance the starter
 * gets hurt, and the engine had no idea any of them were backups, so it kept
 * buying that chance without owning the thing it insures.
 *
 * No depth chart is needed to see it: a much better ADP at the same position
 * on the same team is what being a backup looks like from here. Two rounds is
 * the gap — closer than that is a committee, where both players play.
 *
 * The charge is by position, because "backup" means different things. A
 * second running back or quarterback plays only if the man ahead is hurt. A
 * team's second and third receivers play every week, so the idea barely
 * applies to them. */
export const BACKUP_ADP_GAP = 24;
export const BACKUP_PENALTY = { QB: 30, RB: 25, TE: 12, WR: 4 };

export function backupPenalty(player, mine, players, config) {
  const weight = config.autopilot?.backup_penalty?.[player.pos] ??
    BACKUP_PENALTY[player.pos];
  if (!weight || !player.team) return 0;

  const ahead = players.filter(
    (p) => p.pos === player.pos && p.team === player.team && p.name !== player.name &&
      player.adp - p.adp >= BACKUP_ADP_GAP
  );
  if (ahead.length === 0) return 0;

  /* Handcuffing your own starter is the entire point of a handcuff: you hold
   * the player whose injury would cost you, so the insurance pays out to you.
   * Handcuffing somebody else's is a bet on an injury that helps you only if
   * you then win a bidding war for the job. */
  const mineNames = new Set(mine.map((p) => p.name));
  if (ahead.some((p) => mineNames.has(p.name))) return 0;
  return weight;
}

export function guessPenalty(player, config) {
  if (player.adpSource !== "rank") return 0;
  return config.autopilot?.guessed_adp_penalty ?? GUESSED_ADP_PENALTY;
}

/* The cost of not having filled a starting slot yet, rising as the draft goes
 * on.
 *
 * A mock reached round 6 with no running backs at all and never repaired the
 * position. Nothing in the engine objected, because need was a cliff: a
 * guardrail fires only once a position is within a few players of running dry
 * league-wide, by which point the good ones are gone. Wanting a back in round
 * 4 and needing one in round 6 are different states and scored identically.
 *
 * So an unfilled starting slot pulls candidates at that position forward, by
 * more each round, and by more again when several slots are empty. It is a
 * gradient rather than a rule: nothing here says "take a back by round 5",
 * and the cap is deliberately no larger than one clear tier, so a genuinely
 * elite player at another position still wins. Rounds one and two are
 * untouched — the opening is where value matters most and need matters least.
 *
 * Per position, because the positions are not alike: a missing back is the
 * expensive hole, since replacement backs are the worst on the waiver wire,
 * while receivers are deep enough that waiting costs less. */
/* How much of an open flex slot each position is expected to fill.
 *
 * A W/R/T flex is a starting slot like any other, and a league that starts two
 * of them starts six flex-eligible players, not four. The need gradient used
 * to count only a position's own slots, so it fell silent the moment a roster
 * held two backs and two receivers — with two starting slots still empty and
 * nothing in the engine objecting. The shares match who actually fills a flex
 * in PPR, and tight ends get none for the same reason they cannot claim one
 * in surplusPenalty: it is legal and it is the worst use of the slot. */
export const FLEX_NEED_SHARE = { RB: 0.65, WR: 0.35, TE: 0 };

export const NEED_START_ROUND = 3;
export const NEED_ESCALATION = { RB: 12, WR: 8, TE: 6, QB: 6, K: 0, DEF: 0 };
export const NEED_CAP = 60;

/* The first round in which a kicker or defence may be taken: exactly enough
 * rounds at the end to fill them and no more.
 *
 * Two of them in a fifteen-round draft means rounds fourteen and fifteen. One
 * of them means round fifteen alone — a league with no kicker slot should not
 * inherit a two-round window sized for a league that has one, and give up a
 * round of bench upside to a defence that could have been taken later for the
 * same price. Derived from the roster rather than written down, so it stays
 * right for any shape. */
export function defaultOnesieFloor(config) {
  const starters = config.roster?.starters || {};
  const onesies = (starters.K || 0) + (starters.DEF || 0);
  if (onesies === 0) return Infinity; // this league starts neither
  return Math.max(1, draftableSpotsFor(config) - onesies + 1);
}

/* Every slot a draft actually fills: the starters plus the bench. */
export function draftableSpotsFor(config) {
  const starters = config.roster?.starters || {};
  return Object.values(starters).reduce((a, b) => a + b, 0) + (config.roster?.bench || 0);
}

/* Flex slots not yet covered by a spare at any flex-eligible position. */
export function openFlexSlots(mine, config) {
  const starters = config.roster?.starters || {};
  const flex = starters.FLEX || 0;
  if (!flex) return 0;
  const spares = [...FLEX_ELIGIBLE].reduce(
    (sum, pos) => sum + Math.max(0, mine.filter((p) => p.pos === pos).length - (starters[pos] || 0)),
    0
  );
  return Math.max(0, flex - spares);
}

export function needBonus(player, mine, config, picksMade) {
  const starters = config.roster?.starters || {};
  const need = starters[player.pos] || 0;
  const have = mine.filter((p) => p.pos === player.pos).length;

  const ownSlots = Math.max(0, need - have);
  const shares = config.autopilot?.flex_need_share ?? FLEX_NEED_SHARE;
  const flexSlots = openFlexSlots(mine, config) * (shares[player.pos] ?? 0);
  const missing = ownSlots + flexSlots;
  if (missing <= 0) return 0; // nothing unfilled this player could start in

  const teams = config.league?.num_teams || 10;
  const round = Math.floor(picksMade / teams) + 1;
  const elapsed = round - (config.autopilot?.need_start_round ?? NEED_START_ROUND);
  if (elapsed < 0) return 0;

  const step = config.autopilot?.need_escalation?.[player.pos] ??
    NEED_ESCALATION[player.pos] ?? 0;
  if (!step) return 0;

  const cap = config.autopilot?.need_cap ?? NEED_CAP;
  // elapsed + 1 so the round it switches on is worth something, not zero.
  const pull = step * (elapsed + 1) * missing;
  return -Math.min(pull, cap); // negative: lower score is a better pick
}

/* How much less sure to be about a player his sources disagree about.
 *
 * MarShawn Lloyd was 69th on one fresh board on September 5 and 117th on
 * another on September 7, while the back ahead of him had a court date move
 * forward and stayed on the commissioner's exempt list. Neither board is
 * wrong; his role is unsettled, and averaging 69 and 117 into 93 hides
 * exactly the thing worth knowing. A disagreement is a reason to be less
 * certain, not a number to smooth away.
 *
 * The charge is deliberately small — this decides between players who are
 * otherwise close, and a contested player can still be the right pick. */
export const DISPERSION_BANDS = [
  [36, 20], // the sources are describing different players
  [21, 10],
  [11, 4],
];

export function dispersionPenalty(player, config) {
  const spread = player.adpSpread || 0;
  const bands = config.autopilot?.dispersion_bands ?? DISPERSION_BANDS;
  for (const [floor, weight] of bands) if (spread >= floor) return weight;
  return 0;
}

/* What is actually lost by waiting one more player at this position.
 *
 * A rank difference of one or two inside a tier is noise; the gap between the
 * last player of a strong tier and the first of the next is the whole
 * decision. The room publishes projected points per player, so this is a
 * measurement rather than an inference: the drop from this player to the next
 * available one at his position, converted into draft places at a
 * configurable rate.
 *
 * Null projections mean no information — the rule contributes nothing rather
 * than guessing, the same treatment unknown bye weeks get. */
export const CLIFF_PLACES_PER_POINT = 0.5;
export const CLIFF_CAP = 30;

export function tierCliffBonus(player, players, config) {
  if (typeof player.proj !== "number") return 0;
  const rate = config.autopilot?.cliff_places_per_point ?? CLIFF_PLACES_PER_POINT;
  const cap = config.autopilot?.cliff_cap ?? CLIFF_CAP;

  const nextUp = players
    .filter((p) => p.pos === player.pos && !p.draftedBy && p.name !== player.name &&
      typeof p.proj === "number" && p.adp > player.adp)
    .sort((a, b) => a.adp - b.adp)[0];
  if (!nextUp) return 0;

  const drop = player.proj - nextUp.proj;
  if (drop <= 0) return 0; // the next man up is as good; nothing is lost by waiting
  return -Math.min(drop * rate, cap); // negative: a cliff pulls him forward
}

/* Whether this position can wait until the next turn.
 *
 * Raw ADP already answers "who is best", so scoring a player by his own
 * chance of surviving would only restate it. The thing ADP order does not
 * say is what happens to the *position*: if the next comparable back will
 * also be gone before your next pick, waiting costs you the tier, and if he
 * will still be sitting there, waiting costs nothing at all. That is the
 * difference between two candidates who otherwise score alike.
 *
 * Pairs with the tier cliff, which measures how much is lost. This measures
 * how likely you are to lose it, and stays small because both are estimates
 * built on a market average. */
export const URGENCY_BONUS = 6;
export const PATIENCE_PENALTY = 4;

/* The chance this player is still there at the next turn, as a number rather
 * than a verdict.
 *
 * The scoring rule above deliberately answers a narrower question — whether
 * the *position* keeps — because a player's own survival odds are already
 * most of what ADP order says. This is for the decision record: when a pick
 * looks early afterwards, the argument is always about whether he would have
 * lasted, and a stated probability settles it where a recollection cannot.
 *
 * A logistic on the gap between his ADP and the last pick before our turn:
 * even money at the deadline, and the curve widens for a player his sources
 * disagree about, since disagreement is exactly the case where the market
 * average predicts least well. */
export function availabilityNextPick(player, config, picksMade) {
  const window = config.autopilot?.picks_until_turn;
  if (!Number.isFinite(window) || window <= 0) return null;
  const margin = player.adp - (picksMade + 1 + window);
  const scale = 8 + (player.adpSpread || 0) / 2;
  return Math.round((1 / (1 + Math.exp(-margin / scale))) * 100) / 100;
}

export function urgencyBonus(player, players, config, picksMade) {
  const window = config.autopilot?.picks_until_turn;
  if (!Number.isFinite(window) || window <= 0) return 0; // no turn context

  const nextUp = players
    .filter((p) => p.pos === player.pos && !p.draftedBy && p.name !== player.name &&
      p.adp > player.adp)
    .sort((a, b) => a.adp - b.adp)[0];
  if (!nextUp) return -(config.autopilot?.urgency_bonus ?? URGENCY_BONUS); // last of his kind

  const deadline = picksMade + 1 + window;
  return nextUp.adp <= deadline
    ? -(config.autopilot?.urgency_bonus ?? URGENCY_BONUS)   // his replacement goes too
    : (config.autopilot?.patience_penalty ?? PATIENCE_PENALTY); // the position keeps
}

export function byePenalty(player, mine, config) {
  const weight = config.autopilot?.bye_penalty ?? DEFAULT_BYE_PENALTY;
  if (!weight || !player.bye) return 0;
  const clashes = mine.filter((p) => p.pos === player.pos && p.bye === player.bye).length;
  return clashes * weight;
}

/**
 * @returns {{player, score, reason, needOverride, components, alternatives}|null}
 */
export function autoPick(players, config) {
  const mine = players.filter((p) => p.draftedBy === "mine");
  /* Undrafted anywhere means undrafted here: a player Yahoo shows with no ADP
   * at all is waiver material, and the board's fallback ordering would
   * otherwise present him as an ordinary late pick. */
  const avail = players.filter(
    (p) => !p.draftedBy && !UNAVAILABLE.has(p.status) && !p.undrafted
  );
  if (avail.length === 0) return null;

  const picksMade = players.filter((p) => p.draftedBy).length;
  const scores = scorePlayers(players, config, picksMade);
  /* Kept per player rather than folded straight in, so a pick can say what
   * decided it. Two days were spent reconstructing that from a roster after
   * the fact; the engine knows it at the time and can simply write it down. */
  const components = {};
  // Applied to every path below — a forced need pick should still prefer the
  // candidate who doesn't leave that position empty on the same week.
  for (const p of avail) {
    const parts = {
      adp: scores[p.name],
      bye: byePenalty(p, mine, config),
      surplus: surplusPenalty(p, mine, config),
      guessedAdp: guessPenalty(p, config),
      backup: backupPenalty(p, mine, players, config),
      need: needBonus(p, mine, config, picksMade),
      dispersion: dispersionPenalty(p, config),
      cliff: tierCliffBonus(p, players, config),
      urgency: urgencyBonus(p, players, config, picksMade),
    };
    // Recorded beside the score, not added to it: this is evidence for the
    // log, and the urgency term above already carries the decision.
    parts.availabilityNextPick = availabilityNextPick(p, config, picksMade);
    components[p.name] = parts;
    scores[p.name] = Object.entries(parts)
      .filter(([key]) => key !== "availabilityNextPick")
      .reduce((sum, [, value]) => sum + value, 0);
  }

  /* The nearest alternatives, so a decision record shows what was passed over
   * and by how much — the question every post-draft argument turns on. */
  const alternativesTo = (chosen) =>
    avail
      .filter((p) => p.name !== chosen.name)
      .sort((a, b) => scores[a.name] - scores[b.name])
      .slice(0, 3)
      .map((p) => ({ name: p.name, pos: p.pos, score: round1(scores[p.name]) }));

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

  /* And a hard floor besides. Core-slots-filled releases kickers around round
   * eight in a nine-starter league, and ADP is all that has kept them later
   * than that — a kicker priced at 87 beats a receiver at 95 on the board,
   * which is a bench spot spent on a position whose replacement is free all
   * season. The floor is the last two rounds of the roster, whatever its
   * size. The roster-completion override below reads the unfiltered pool, so
   * a draft that somehow reaches its end still fills the slot. */
  const roundNow = Math.floor(picksMade / config.league.num_teams) + 1;
  const onesieFloor = config.autopilot?.onesie_min_round ?? defaultOnesieFloor(config);

  let pool = avail;
  if (!(coreFilled || lateEnough) || roundNow < onesieFloor) {
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
  const draftableSpots = draftableSpotsFor(config);
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
      return {
        player: best, score: scores[best.name], reason, needOverride: true,
        components: components[best.name], alternatives: alternativesTo(best),
      };
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
      return {
        player: best, score: scores[best.name], reason, needOverride: true,
        components: components[best.name], alternatives: alternativesTo(best),
      };
    }
  }

  // --- Otherwise: best player available by adjusted score.
  const best = minBy(pool, (p) => scores[p.name]);
  const bits = [
    `Best available by adjusted value (raw ADP ${best.adp}, adjusted ${scores[best.name].toFixed(1)}).`,
  ];
  if (best.note) bits.push(`${best.noteTag}: ${best.note}`);
  return {
    player: best, score: scores[best.name], reason: bits.join(" "), needOverride: false,
    components: components[best.name], alternatives: alternativesTo(best),
  };
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
