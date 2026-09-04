/*
 * Draft board: ADP + league config -> position tiers + replacement-level
 * cutoffs. A faithful port of fantasy_manager/board.py — same fields, same
 * tiering rule, same replacement-level formula. Kept in sync by hand; the
 * golden-master test in extension/test/compare_with_python.js runs both
 * engines against the same simulated draft and diffs the output, which
 * would catch a port bug the Python tests alone couldn't.
 *
 * Vanilla JS, no build step: this file is loaded directly via a <script>
 * tag / ES module import in the extension, exactly the way web.py needed
 * nothing but the Python standard library.
 */

// Source data uses a few position labels that don't match our vocabulary
// (FantasyFootballCalculator labels kickers "PK") — normalized on load so
// the rest of the engine only ever sees QB/RB/WR/TE/K/DEF.
export const POS_ALIASES = { PK: "K", DST: "DEF", "D/ST": "DEF" };

export function normalizePos(pos) {
  return POS_ALIASES[pos] || pos;
}

export function makePlayer({ rank, name, team, pos, adp }) {
  return {
    rank,
    name,
    team,
    pos: normalizePos(pos),
    adp,
    tier: 0,
    draftedBy: null, // null | "mine" | "rival"
    noteTag: null,
    note: null,
    adjustment: 0,
  };
}

// adjustedAdp is what auto_pick sorts on; .adp is kept untouched for display
// so the market's number is always visible next to the research-informed one.
export function adjustedAdp(player) {
  return player.adp + player.adjustment;
}

export function loadPlayers(rows) {
  return rows.map((r) => makePlayer(r));
}

/**
 * Researched risk/upside notes (bust/injury_watch/breakout/value_note),
 * keyed by exact player name — the same key the ADP board uses, so a name
 * that doesn't match attaches no value. See data/player_notes_2026.csv for
 * sourcing per player.
 */
export function applyNotes(players, notes) {
  for (const p of players) {
    const n = notes[p.name];
    if (!n) continue;
    p.noteTag = n.tag;
    p.note = n.note;
    // "bust"/"injury_watch"/"value_note" push adjustedAdp later (worse);
    // "breakout" pulls it earlier (better).
    const sign = n.tag === "breakout" ? -1 : 1;
    p.adjustment = sign * n.adjustment;
  }
}

/**
 * Tier players within each position by clustering on ADP gaps. A new tier
 * starts whenever the jump to the next player's ADP is at least minGap
 * picks AND at least relativeGap of the current ADP — early-round gaps are
 * tiny in absolute terms but still meaningful; late-round gaps need a bigger
 * absolute jump to mean anything.
 */
export function assignTiers(players, relativeGap = 0.15, minGap = 3.0) {
  const byPos = new Map();
  for (const p of players) {
    if (!byPos.has(p.pos)) byPos.set(p.pos, []);
    byPos.get(p.pos).push(p);
  }

  for (const list of byPos.values()) {
    list.sort((a, b) => a.adp - b.adp);
    let tier = 1;
    list[0].tier = tier;
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1];
      const cur = list[i];
      const gap = cur.adp - prev.adp;
      const threshold = Math.max(minGap, prev.adp * relativeGap);
      if (gap >= threshold) tier += 1;
      cur.tier = tier;
    }
  }
}

/**
 * Rough replacement-level draft rank per position, given league size and
 * starting roster. FLEX is split ~60/35/5 between RB/WR/TE.
 *
 * A position absent from starters (e.g. a league with no kicker slot) is
 * never guessed at 1 — that would mean "assume everyone starts one" for a
 * position this league never starts at all. Its replacement level is 0,
 * matching board.py's fix for the same class of bug.
 */
export function replacementRanks(config) {
  const teams = config.league.num_teams;
  const starters = config.roster.starters;
  const flex = starters.FLEX || 0;

  const effective = {
    QB: starters.QB || 0,
    RB: (starters.RB || 0) + 0.6 * flex,
    WR: (starters.WR || 0) + 0.35 * flex,
    TE: (starters.TE || 0) + 0.05 * flex,
    K: starters.K || 0,
    DEF: starters.DEF || 0,
  };

  const out = {};
  for (const [pos, mult] of Object.entries(effective)) {
    out[pos] = mult > 0 ? Math.max(1, Math.round(teams * mult)) : 0;
  }
  return out;
}

export function applyDraftState(players, state) {
  const byName = new Map(players.map((p) => [p.name, p]));
  for (const [name, by] of Object.entries(state.drafted || {})) {
    const p = byName.get(name);
    if (p) p.draftedBy = by;
  }
}

export function buildBoard(adpRows, notesByName, config) {
  const players = loadPlayers(adpRows);
  applyNotes(players, notesByName);
  assignTiers(players);
  return players;
}

/** One line per position: how many undrafted players remain before the
 * replacement-level cliff, and how many are left in the current top tier.
 * Positions this league never starts (replacement rank 0) are omitted —
 * a "10 startable kickers left" line would be actively misleading for a
 * league with no kicker slot. */
export function scarcityReport(players, config) {
  const repl = replacementRanks(config);
  const lines = [];
  for (const pos of ["QB", "RB", "WR", "TE", "K", "DEF"]) {
    if (repl[pos] === 0) continue;
    const avail = players.filter((p) => p.pos === pos && !p.draftedBy).sort((a, b) => a.adp - b.adp);
    if (avail.length === 0) {
      lines.push(`${pos}: none left`);
      continue;
    }
    const topTier = avail[0].tier;
    const inTopTier = avail.filter((p) => p.tier === topTier).length;
    const draftedAtPos = players.filter((p) => p.pos === pos && p.draftedBy).length;
    const remainingStartable = Math.max(0, repl[pos] - draftedAtPos);
    lines.push(
      `${pos}: ${inTopTier} left in Tier ${topTier} ` +
        `(${remainingStartable} startable-caliber players left league-wide)`
    );
  }
  return lines;
}

/* Bye weeks, from the team map. A player with no known team keeps bye null,
 * and every rule below treats null as "no information" rather than "no
 * clash" — guessing here would quietly build the thing it's meant to avoid. */
export function applyByes(players, byeWeeks) {
  for (const p of players) p.bye = byeWeeks[p.team] ?? null;
  return players;
}
