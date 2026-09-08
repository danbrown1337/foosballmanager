/*
 * Post-draft grading.
 *
 * Two days of this project were spent grading rosters by hand — reading a
 * panel log, counting positions, arguing about whether a pick was a reach.
 * Every one of those judgements is computable from the board the engine
 * already holds, and computing them turns each mock into a regression test
 * instead of a conversation.
 *
 * The rubric is starter quality relative to replacement level, because that
 * is the thing a fantasy roster is actually made of: a running back is good
 * or bad only compared to the back you could have had instead. Replacement
 * level comes from the league's own settings, so a shallower league grades
 * differently from a deep one, correctly.
 */
import { replacementRanks } from "./board.js";
import { backupPenalty } from "./autopilot.js";

/* Positions where the player you got is what matters. */
const QUALITY_POSITIONS = new Set(["QB", "RB", "WR", "TE"]);

const LETTERS = [
  [97, "A+"], [93, "A"], [90, "A-"],
  [87, "B+"], [83, "B"], [80, "B-"],
  [77, "C+"], [73, "C"], [70, "C-"],
  [67, "D+"], [63, "D"], [60, "D-"],
];

export function letterFor(score) {
  for (const [floor, letter] of LETTERS) if (score >= floor) return letter;
  return "F";
}

/* Where a player sits among everyone at his position, by ADP. Rank, not raw
 * ADP, because the positions are priced on different scales — the 12th
 * quarterback and the 12th running back are nothing like the same player. */
function positionRanks(players) {
  const byPos = new Map();
  for (const p of players) {
    if (!byPos.has(p.pos)) byPos.set(p.pos, []);
    byPos.get(p.pos).push(p);
  }
  const ranks = new Map();
  for (const list of byPos.values()) {
    list.sort((a, b) => a.adp - b.adp);
    list.forEach((p, i) => ranks.set(p.name, i + 1));
  }
  return ranks;
}

/* 50 is replacement level — a starter you could have had for nothing. 100 is
 * the best player at the position. Below 50 means the slot is actively
 * costing you against the field. */
function scoreForPosition(starters, replacement) {
  if (starters.length === 0) return 0;
  if (!replacement) return 50;
  const mean = starters.reduce((sum, rank) => sum + (replacement - rank), 0) / starters.length;
  return Math.max(0, Math.min(100, 50 + (50 * mean) / replacement));
}

/**
 * @param {Array} players  the whole board, with draftedBy set
 * @param {object} config  league settings
 * @param {Array} [log]    decision records, if the draft kept one — enables
 *                         the flags that depend on when a pick was made
 */
export function gradeRoster(players, config, log = null) {
  const mine = players.filter((p) => p.draftedBy === "mine");
  const starters = config.roster?.starters || {};
  const spots = Object.values(starters).reduce((a, b) => a + b, 0) + (config.roster?.bench || 0);
  /* A draft in progress is not a bad draft.
   *
   * Unfilled starting slots score zero, which is the right answer for a
   * finished roster and nonsense for one in round three: a team with a
   * quarterback, two receivers and eleven picks still to come came back
   * "overall F, RB F, TE F, DEF F". The report is still worth producing
   * mid-draft — the flags and the position scores are real — but it has to
   * say what it is rather than hand back a verdict on a team that does not
   * exist yet. */
  const inProgress = spots > 0 && mine.length < spots;
  const repl = replacementRanks(config);
  const ranks = positionRanks(players);

  const grades = {};
  const scores = {};
  const positions = Object.keys(starters).filter((pos) => pos !== "FLEX");
  const roundDrafted = (pos) => {
    const hit = log?.find((entry) => entry.pos === pos);
    return hit ? hit.round : null;
  };
  const floor = config.autopilot?.onesie_min_round ?? 0;

  for (const pos of positions) {
    const need = starters[pos] || 0;
    const atPos = mine.filter((p) => p.pos === pos).sort((a, b) => a.adp - b.adp);
    const used = atPos.slice(0, need).map((p) => ranks.get(p.name) ?? repl[pos]);
    /* An empty starting slot is not a low score, it is a zero: no waiver
     * pickup rescues a lineup that cannot be fielded. */
    if (used.length < need) {
      scores[pos] = used.length === 0
        ? 0
        : scoreForPosition(used, repl[pos]) * (used.length / need);
      grades[pos] = letterFor(scores[pos]);
      continue;
    }

    /* Kickers and defences are graded on when they were taken, not on who
     * they are. Week to week they are close to noise, so the only decision
     * that carries value is how little was spent getting one — the same
     * reason the engine holds them to the last rounds. Grading them against
     * replacement level would score a correctly-late kicker zero and mark
     * a wasted eighth-round pick as excellent. */
    if (!QUALITY_POSITIONS.has(pos)) {
      const round = roundDrafted(pos);
      scores[pos] = round === null || !floor
        ? 85 // no log to judge by; assume it was fine rather than invent a fault
        : Math.max(0, Math.min(100, 95 - 8 * Math.max(0, floor - round)));
      grades[pos] = letterFor(scores[pos]);
      continue;
    }

    scores[pos] = scoreForPosition(used, repl[pos]);
    grades[pos] = letterFor(scores[pos]);
  }

  // Weighted by how much of the lineup each position is.
  const totalNeed = positions.reduce((sum, pos) => sum + (starters[pos] || 0), 0) || 1;
  let overall = positions.reduce(
    (sum, pos) => sum + scores[pos] * (starters[pos] || 0), 0) / totalNeed;

  const flags = [];
  const strengths = [];

  for (const pos of positions) {
    if (mine.filter((p) => p.pos === pos).length < (starters[pos] || 0)) {
      flags.push(`unfilled_starter_${pos.toLowerCase()}`);
      overall -= 10;
    }
  }

  // Onesie redundancy: a second one of these never starts.
  for (const pos of ["QB", "K", "DEF"]) {
    const have = mine.filter((p) => p.pos === pos).length;
    if (have > (starters[pos] || 0)) {
      flags.push(`redundant_${pos.toLowerCase()}${have}`);
      overall -= 4;
    }
  }
  const tes = mine.filter((p) => p.pos === "TE").sort((a, b) => a.adp - b.adp);
  const eliteTe = tes.length > 0 && (ranks.get(tes[0].name) ?? 99) <= 5;
  if (eliteTe && tes.length > (starters.TE || 0)) {
    flags.push("redundant_te2_behind_elite_te");
    overall -= 4;
  }
  if (eliteTe) strengths.push("elite_te_advantage");

  // Other managers' handcuffs: insurance on a starter you don't own.
  const handcuffs = mine.filter((p) => backupPenalty(p, mine, players, config) > 0);
  if (handcuffs.length >= 2) {
    flags.push(`backup_heavy_${handcuffs.length}`);
    overall -= 3 * (handcuffs.length - 1);
  }

  // A bye that empties the lineup.
  const byeCounts = {};
  for (const p of mine) if (p.bye) byeCounts[p.bye] = (byeCounts[p.bye] || 0) + 1;
  const worstBye = Object.entries(byeCounts).sort((a, b) => b[1] - a[1])[0];
  if (worstBye && worstBye[1] >= 4) {
    flags.push(`bye_concentration_week_${worstBye[0]}_${worstBye[1]}_players`);
    overall -= 3;
  }

  // Players whose ADP was never a real ADP.
  const guessed = mine.filter((p) => p.adpSource === "rank");
  if (guessed.length > 0) flags.push(`guessed_adp_picks_${guessed.length}`);

  if (log?.length) {
    const roundOf = (pos) => {
      const hit = log.find((entry) => entry.pos === pos);
      return hit ? hit.round : null;
    };
    const firstRb = roundOf("RB");
    if (firstRb !== null && firstRb > 4) {
      flags.push(`no_rb_until_round_${firstRb}`);
      overall -= 5;
    }
    const kRound = roundOf("K");
    const dstRound = roundOf("DEF");
    if (floor && ((kRound && kRound < floor) || (dstRound && dstRound < floor))) {
      // The position score above already carries the cost; this names it.
      flags.push("k_or_dst_drafted_early");
    } else if (kRound || dstRound) {
      strengths.push("late_k_dst");
    }
  }

  if ((scores.WR ?? 0) >= 85) strengths.push("elite_wr_core");
  if ((scores.RB ?? 0) >= 85) strengths.push("elite_rb_core");
  if (mine.filter((p) => p.pos === "RB").length >= (starters.RB || 0) + 2) {
    strengths.push("rb_depth");
  }

  overall = Math.max(0, Math.min(100, overall));
  return {
    inProgress,
    picksMade: mine.length,
    spots,
    grades: { ...grades, overall: inProgress ? null : letterFor(overall) },
    scores: { ...scores, overall: Math.round(overall * 10) / 10 },
    constructionFlags: flags,
    strengths,
  };
}
