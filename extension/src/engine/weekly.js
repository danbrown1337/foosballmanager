/*
 * In-season weekly engine — a faithful port of fantasy_manager/weekly.py.
 *
 * Start/sit and waiver evaluation, mirroring the Python module decision for
 * decision. compare_weekly_with_python.js replays the Python engine's own
 * output through this one and diffs every field, the same way the draft
 * engine is pinned — reading the two side by side is not evidence, and the
 * draft port has already shown that a plausible-looking JS translation can
 * disagree with Python in ways only a diff catches.
 *
 * Players here are plain objects, not a class, so a row can go straight from
 * a scrape or from JSON into the engine:
 *   {name, pos, team, slot, status, opponent, proj, bye, byeWeek}
 * `proj` of null means "no projection", which is deliberately NOT the same as
 * 0 — see rankKey.
 *
 * SCOPE: recommend-only, exactly as in Python and everywhere else in this
 * project. Nothing here sets a lineup or places a claim.
 */

// Yahoo's designations, split by what each means for a lineup.
//   HARD_OUT — cannot play. Starting one scores zero.
//   SOFT_OUT — can play, usually doesn't. Excluded by default because Yahoo's
//              projection often doesn't zero these, so trusting the number
//              would quietly start a player who sits.
//   FLAGGED  — expected to play. Startable, but surfaced every time.
export const HARD_OUT = new Set(["O", "OUT", "IR", "IR-R", "SUSP", "PUP", "NA", "BYE"]);
export const SOFT_OUT = new Set(["D", "DOUBTFUL"]);
export const FLAGGED = new Set(["Q", "QUESTIONABLE", "GTD", "P", "PROBABLE"]);

// Which positions each flex-style slot accepts. Yahoo writes the standard one
// "W/R/T"; the config template writes "FLEX". Both mean the same thing.
export const FLEX_SLOTS = {
  "FLEX": ["RB", "WR", "TE"],
  "W/R/T": ["RB", "WR", "TE"],
  "WRT": ["RB", "WR", "TE"],
  "SUPERFLEX": ["QB", "RB", "WR", "TE"],
  "SFLEX": ["QB", "RB", "WR", "TE"],
  "OP": ["QB", "RB", "WR", "TE"],
  "Q/W/R/T": ["QB", "RB", "WR", "TE"],
};

export const BENCH_SLOTS = new Set(["BN", "BE", "BENCH", "IR", "IR-R", "NA"]);

const upper = (value) => String(value || "").toUpperCase();

/**
 * Python's round(), which JS does not have.
 *
 * Math.round() rounds a half away from zero; Python rounds it to even. That
 * is not pedantry here — at a $50 budget the 25% band lands on exactly 12.5,
 * so Math.round would tell a JS user to bid 13 where the Python report says
 * 12. The golden-master diff caught it on its first run. Both languages use
 * IEEE-754 doubles, so replicating only the tie-break makes the two agree.
 */
export function pyRound(value, digits = 0) {
  const factor = 10 ** digits;
  const scaled = value * factor;
  const floor = Math.floor(scaled);
  const remainder = scaled - floor;
  let rounded;
  if (remainder > 0.5) rounded = floor + 1;
  else if (remainder < 0.5) rounded = floor;
  else rounded = Math.abs(floor % 2) === 0 ? floor : floor + 1;
  return rounded / factor;
}

export function isPlayable(player) {
  return !player.bye && !HARD_OUT.has(upper(player.status));
}

export function isStartable(player) {
  return isPlayable(player) && !SOFT_OUT.has(upper(player.status));
}

export function isFlagged(player) {
  return FLAGGED.has(upper(player.status));
}

export function statusLabel(player) {
  return player.bye ? "BYE" : upper(player.status);
}

/* The available-players page distinguishes two things the manager does
 * differently, and collapsing them into "available" would hand someone a
 * deadline they don't have or hide one they do:
 *   "FA"          — add right now, first come.
 *   "W (Sep 11)"  — a claim, placed before that date, processed then.
 * Ports WeeklyPlayer.is_free_agent / .waiver_clears. */
export function isFreeAgent(player) {
  return upper((player || {}).rosterStatus).trim() === "FA";
}

/** When a claim on this player processes, if the page said. */
export function waiverClears(player) {
  const match = /^W\s*\(([^)]*)\)/i.exec(String((player || {}).rosterStatus || "").trim());
  return match ? match[1] : null;
}

/**
 * Turn {QB: 1, RB: 2, FLEX: 2} into ["QB", "RB", "RB", "FLEX", "FLEX"].
 *
 * Order is most-restrictive-first, and that ordering is load-bearing: the fill
 * below is greedy, so a slot accepting fewer positions has to claim its player
 * before a wider one takes him. A league running both a W/R/T and a superflex
 * makes it concrete — fill the superflex first with the best player left and it
 * can swallow the only running back, stranding the W/R/T beside a quarterback
 * it cannot use. Dedicated slots take exactly one position, so they go first.
 *
 * An absent position stays absent: no kicker slot means no kicker, ever.
 */
export function expandSlots(starters, superflex = false) {
  const dedicated = [];
  let flex = [];
  for (const [rawSlot, rawCount] of Object.entries(starters || {})) {
    const slot = upper(rawSlot);
    const count = Number.parseInt(rawCount, 10);
    if (!Number.isFinite(count)) continue;
    const target = slot in FLEX_SLOTS ? flex : dedicated;
    for (let i = 0; i < Math.max(0, count); i += 1) target.push(slot);
  }
  if (superflex) flex = flex.map((s) => (s in FLEX_SLOTS ? "SUPERFLEX" : s));
  flex.sort((a, b) => {
    const byWidth = FLEX_SLOTS[a].length - FLEX_SLOTS[b].length;
    return byWidth !== 0 ? byWidth : a.localeCompare(b);
  });
  return [...dedicated, ...flex];
}

export function slotAccepts(slot, pos) {
  const key = upper(slot);
  if (key in FLEX_SLOTS) return FLEX_SLOTS[key].includes(upper(pos));
  return key === upper(pos);
}

/**
 * "W/R/T" and "FLEX" are two names for one slot; comparing the raw strings
 * would report a move between them that nobody has to make.
 */
export function canonicalSlot(slot) {
  if (!slot) return "";
  const key = upper(slot);
  if (key in FLEX_SLOTS) return FLEX_SLOTS[key].length === 3 ? "FLEX" : "SUPERFLEX";
  return key;
}

/**
 * Sort comparator for "who is better this week".
 *
 * A player with no projection sorts last among the startable rather than being
 * treated as zero. "No information" and "projected to score nothing" are
 * different claims and only one of them is true.
 */
function rankCompare(a, b) {
  const aMissing = a.proj === null || a.proj === undefined;
  const bMissing = b.proj === null || b.proj === undefined;
  if (aMissing !== bMissing) return aMissing ? 1 : -1;
  const byProj = (b.proj || 0) - (a.proj || 0);
  if (byProj !== 0) return byProj;
  return a.name.localeCompare(b.name);
}

/**
 * Best legal lineup by projected points.
 *
 * Greedy is exactly optimal here, not merely convenient: fill each dedicated
 * slot with the top players at that position, then fill flex from whoever is
 * left. If some optimal lineup starts a weaker RB while a better one sits, then
 * either the better one is benched (swapping strictly improves it, so it wasn't
 * optimal) or he is in a flex slot (swapping leaves the total unchanged, since
 * both slots take RBs). Either way an optimal lineup exists with the top RBs in
 * the RB slots, and induction gives the rest. The Python side checks this
 * against brute-force enumeration; this side is pinned to the Python side.
 *
 * @returns {{starters: {slot: string, player: object|null, emptyReason: string|null}[],
 *            bench: object[], warnings: string[], projected: number}}
 */
export function optimalLineup(players, starters, { superflex = false, allowDoubtful = false } = {}) {
  const warnings = [];
  const pool = players.filter((p) => isStartable(p) || (allowDoubtful && isPlayable(p)));

  const benchedOut = players.filter((p) => !isPlayable(p));
  for (const p of benchedOut) {
    if (p.slot && !BENCH_SLOTS.has(upper(p.slot))) {
      warnings.push(
        `${p.name} is in your ${p.slot} slot but is ${statusLabel(p)} — that slot scores 0 as it stands.`);
    }
  }
  if (!allowDoubtful) {
    for (const p of players) {
      if (isPlayable(p) && !isStartable(p)) {
        warnings.push(
          `${p.name} is ${statusLabel(p)} and left out. Re-run with --allow-doubtful to consider him.`);
      }
    }
  }

  const remaining = [...pool].sort(rankCompare);
  const assignments = [];
  for (const slot of expandSlots(starters, superflex)) {
    const index = remaining.findIndex((p) => slotAccepts(slot, p.pos));
    if (index === -1) {
      assignments.push({
        slot,
        player: null,
        emptyReason: `nobody healthy on your roster fills ${slot}`,
      });
      continue;
    }
    assignments.push({ slot, player: remaining.splice(index, 1)[0], emptyReason: null });
  }

  const missing = assignments
    .filter((a) => a.player && (a.player.proj === null || a.player.proj === undefined))
    .map((a) => a.player.name)
    .sort();
  if (missing.length) {
    warnings.push(
      `No weekly projection for ${missing.join(", ")} — they were slotted on position `
      + "eligibility alone, not ranked. Re-import the My Team page to pick up projections.");
  }

  const projected = assignments.reduce((sum, a) => sum + ((a.player && a.player.proj) || 0), 0);
  return { starters: assignments, bench: [...remaining, ...benchedOut], warnings, projected };
}

export function lineupNames(lineup) {
  return new Set(lineup.starters.filter((a) => a.player).map((a) => a.player.name));
}

/**
 * Diff Yahoo's current lineup against the optimal one.
 *
 * This — not the lineup itself — is the actionable output. "Start these nine"
 * makes the manager re-derive what to click; "bench X for Y" is the move.
 */
export function lineupChanges(current, best) {
  const currentlyStarting = new Map();
  for (const p of current) {
    if (p.slot && !BENCH_SLOTS.has(upper(p.slot))) currentlyStarting.set(p.name, p);
  }
  const shouldStart = lineupNames(best);

  const comingIn = best.starters.filter(
    (a) => a.player && !currentlyStarting.has(a.player.name));
  const goingOut = [...currentlyStarting.values()].filter((p) => !shouldStart.has(p.name));

  const changes = [];
  for (const assignment of comingIn) {
    const incoming = assignment.player;
    // Pair each promotion with a demotion at a slot the incoming player can
    // fill, so the instruction is executable exactly as written.
    let matchIndex = goingOut.findIndex((p) => slotAccepts(assignment.slot, p.pos));
    if (matchIndex === -1 && goingOut.length) matchIndex = 0;
    const match = matchIndex === -1 ? null : goingOut.splice(matchIndex, 1)[0];

    let gain = null;
    if (incoming.proj !== null && incoming.proj !== undefined
        && match && match.proj !== null && match.proj !== undefined) {
      gain = pyRound(incoming.proj - match.proj, 2);
    }

    let reason;
    if (!match) reason = `${assignment.slot} is empty`;
    else if (!isPlayable(match)) reason = `${match.name} is ${statusLabel(match)}`;
    else if (gain !== null) reason = `projects ${gain >= 0 ? "+" : ""}${gain.toFixed(2)} over ${match.name}`;
    else reason = `ranked above ${match.name}`;

    changes.push({
      slot: assignment.slot,
      benchPlayer: match,
      startPlayer: incoming,
      gain,
      reason,
      moveOnly: false,
    });
  }

  // Anyone left over comes out with nobody specific replacing them.
  for (const orphan of goingOut) {
    changes.push({
      slot: orphan.slot || orphan.pos,
      benchPlayer: orphan,
      startPlayer: null,
      gain: null,
      reason: !isPlayable(orphan)
        ? `${orphan.name} is ${statusLabel(orphan)}`
        : `${orphan.name} is out-projected by your bench`,
      moveOnly: false,
    });
  }

  // Finally, players who stay in the lineup but belong in a different slot.
  // Nobody is benched, so the swap logic above stays silent — and leaving a
  // tight end in a flex spot means the TE slot scores zero.
  for (const assignment of best.starters) {
    const player = assignment.player;
    if (!player || !currentlyStarting.has(player.name)) continue;
    const was = canonicalSlot(currentlyStarting.get(player.name).slot);
    const now = canonicalSlot(assignment.slot);
    if (was && now && was !== now) {
      changes.push({
        slot: assignment.slot,
        benchPlayer: null,
        startPlayer: player,
        gain: null,
        reason: `move from ${currentlyStarting.get(player.name).slot} to ${assignment.slot}`,
        moveOnly: true,
      });
    }
  }
  return changes;
}

// --- Waivers ----------------------------------------------------------------
//
// A heuristic, not a market price, so it lives in the open where it can be
// argued with. The number that matters is the projected gain over whoever you
// would otherwise start; the percentage says how hard that gain is worth
// chasing out of a finite budget. Kept identical to FAAB_BANDS in weekly.py.
export const FAAB_BANDS = [
  [8.0, 0.30, 0.45, "clear starter upgrade at a position you're thin at"],
  [4.0, 0.15, 0.25, "starts for you most weeks"],
  [1.5, 0.05, 0.12, "marginal starter / good bench"],
  [0.0, 0.01, 0.04, "depth, stash, or a one-week bye fill"],
];

/** The weakest player holding a slot this position could take — i.e. what a
 * pickup would actually be replacing. Null when a slot sits empty, because
 * then the replacement level is zero. */
function worstStartable(lineup, pos) {
  const empty = lineup.starters.filter((a) => !a.player && slotAccepts(a.slot, pos));
  if (empty.length) return null;
  const candidates = lineup.starters
    .filter((a) => a.player && slotAccepts(a.slot, pos))
    .map((a) => a.player);
  if (!candidates.length) return null;
  return candidates.reduce((worst, p) => {
    const pMissing = p.proj === null || p.proj === undefined;
    const wMissing = worst.proj === null || worst.proj === undefined;
    if (pMissing !== wMissing) return pMissing ? p : worst;
    return (p.proj || 0) < (worst.proj || 0) ? p : worst;
  });
}

function priceTarget(target, faabRemaining) {
  if (target.gain === null) {
    target.worthPriority = false;
    return;
  }
  for (const [threshold, low, high, label] of FAAB_BANDS) {
    if (target.gain >= threshold) {
      target.note = label;
      if (faabRemaining) {
        target.bidLow = Math.max(1, pyRound(faabRemaining * low));
        target.bidHigh = Math.max(target.bidLow, pyRound(faabRemaining * high));
      }
      // Burning a numbered waiver priority drops you to last, so it is only
      // worth it for someone who starts beyond this single week.
      target.worthPriority = target.gain >= 4.0;
      return;
    }
  }
}

/**
 * Rank free agents by what they'd add to *this* lineup.
 *
 * A claim is only worth what it upgrades: the best available player is the
 * wrong pickup if he'd sit behind two better ones at his position, and a
 * mediocre one is right if he fills a slot that is currently empty.
 */
export function evaluateWaiverTargets(available, roster, starters, options = {}) {
  const { superflex = false, faabRemaining = null, top = 10 } = options;
  const best = optimalLineup(roster, starters, { superflex });
  const started = lineupNames(best);
  const droppable = roster
    .filter((p) => !started.has(p.name))
    .sort((a, b) => {
      const aMissing = a.proj === null || a.proj === undefined;
      const bMissing = b.proj === null || b.proj === undefined;
      if (aMissing !== bMissing) return aMissing ? 1 : -1;
      return (a.proj || 0) - (b.proj || 0) || a.name.localeCompare(b.name);
    });

  const targets = [];
  available.forEach((candidate, order) => {
    if (!isPlayable(candidate)) return;
    const incumbent = worstStartable(best, candidate.pos);

    let gain;
    let rationale;
    if (incumbent === null) {
      gain = candidate.proj === undefined ? null : candidate.proj;
      rationale = `fills an empty ${candidate.pos} slot`;
    } else if (candidate.proj === null || candidate.proj === undefined
               || incumbent.proj === null || incumbent.proj === undefined) {
      gain = null;
      rationale = `no weekly projection — compare against ${incumbent.name} yourself`;
    } else {
      gain = pyRound(candidate.proj - incumbent.proj, 2);
      rationale = gain <= 0
        ? `would sit behind ${incumbent.name}; depth only`
        : `projects ${gain >= 0 ? "+" : ""}${gain.toFixed(2)} over ${incumbent.name}`;
    }

    const target = {
      player: candidate,
      gain,
      replaces: incumbent,
      drop: droppable.length ? droppable[0] : null,
      rationale,
      bidLow: null,
      bidHigh: null,
      worthPriority: false,
      note: null,
      order,
    };
    priceTarget(target, faabRemaining);
    targets.push(target);
  });

  // Ties and unrankable candidates keep the order they arrived in. With no
  // weekly projections every gain is null, and falling back to the name would
  // throw away the incoming ADP order and rank the wire alphabetically.
  targets.sort((a, b) => {
    const aMissing = a.gain === null;
    const bMissing = b.gain === null;
    if (aMissing !== bMissing) return aMissing ? 1 : -1;
    return (b.gain || 0) - (a.gain || 0) || a.order - b.order;
  });
  return targets.slice(0, top);
}

// --- Season calendar --------------------------------------------------------

/**
 * Which NFL week it is, from season.week1_start. Returns null rather than
 * guessing when it isn't configured — a report that silently assumes the wrong
 * week is how you set a Week 3 lineup in Week 4.
 */
export function currentWeek(config, today = new Date()) {
  const start = ((config || {}).season || {}).week1_start;
  if (!start) return null;
  const kickoff = new Date(`${start}T00:00:00Z`);
  if (Number.isNaN(kickoff.getTime())) return null;
  const midnightUTC = Date.UTC(
    today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const days = Math.floor((midnightUTC - kickoff.getTime()) / 86400000);
  if (days < 0) return null;
  return Math.min(18, Math.floor(days / 7) + 1);
}

/** A short heading that keeps "before kickoff" and "nobody configured a season
 * start" distinct — one is a date to wait for, the other a line to fill in. */
export function weekLabel(config, today = new Date()) {
  const week = currentWeek(config, today);
  if (week) return `Week ${week}`;
  const start = ((config || {}).season || {}).week1_start;
  return start ? `Preseason (Week 1 kicks off ${start})` : "Week unknown";
}

/** [system, faabRemaining]. Defaults to FAAB, which is what most Yahoo leagues
 * run — but the report says which it assumed, so a priority league notices
 * immediately rather than acting on a bid. */
export function waiverSystem(config) {
  const waivers = (config || {}).waivers || {};
  let system = String(waivers.system || "faab").toLowerCase();
  if (system !== "faab" && system !== "priority") system = "faab";
  let remaining = waivers.faab_remaining;
  if (remaining === null || remaining === undefined) remaining = waivers.faab_budget;
  const parsed = Number.parseInt(remaining, 10);
  return [system, Number.isFinite(parsed) ? parsed : null];
}

/**
 * Upcoming weeks where byes would leave a starting slot short.
 *
 * Looks only weeksAhead out: a pileup in Week 11 is not this week's problem,
 * and a claim made six weeks early wastes a roster spot for six weeks.
 */
export function byeOutlook(roster, byeWeeks, week, starters, weeksAhead = 3) {
  if (!week) return [];

  const needed = {};
  for (const slot of expandSlots(starters)) {
    if (slot in FLEX_SLOTS) continue;
    needed[slot] = (needed[slot] || 0) + 1;
  }

  // The page's own number when we have it, the shipped table otherwise: that
  // table is a hand-maintained snapshot and cannot know about a moved game.
  const byeFor = (p) => (
    p.byeWeek === null || p.byeWeek === undefined
      ? byeWeeks[upper(p.team)]
      : p.byeWeek);

  const out = [];
  for (let ahead = 1; ahead <= weeksAhead; ahead += 1) {
    const targetWeek = week + ahead;
    const onBye = roster.filter((p) => byeFor(p) === targetWeek);
    if (!onBye.length) continue;

    const byPos = {};
    for (const p of onBye) byPos[p.pos] = (byPos[p.pos] || 0) + 1;

    const short = Object.entries(byPos)
      .filter(([pos, count]) => {
        const left = roster.filter((p) => p.pos === pos).length - count;
        return left < (needed[pos] || 0);
      })
      .map(([pos]) => pos);

    if (short.length) out.push([targetWeek, onBye.filter((p) => short.includes(p.pos))]);
  }
  return out;
}
