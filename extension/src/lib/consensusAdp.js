/*
 * Consensus ADP from Fantasy Football Calculator.
 *
 * Yahoo publishes ADP only inside a draft room, so before a draft the board
 * has no idea where players actually go — it orders by list position. This is
 * a free, keyless JSON feed of ADP aggregated across thousands of mock drafts,
 * by scoring format and league size, and the site invites use in other
 * applications.
 *
 * It is chosen over the alternatives for a reason beyond price: its names
 * match the ones already on the board, defences included ("Seattle Defense")
 * and kickers as PK. Every painful bug in this project has come from two
 * sources naming the same player differently, so a source that agrees with
 * the existing data is worth more than a marginally better one that doesn't.
 *
 * ESPN has no public ADP endpoint — its APIs are league-scoped. FantasyPros
 * requires a paid key. Both were considered and rejected.
 */

const BASE = "https://fantasyfootballcalculator.com/api/v1/adp";

/** Their format names, from ours. */
export function scoringFormat(scoring) {
  if (scoring === "half_ppr") return "half-ppr";
  if (scoring === "standard") return "standard";
  return "ppr";
}

export function adpUrl({ scoring = "ppr", teams = 12, year = new Date().getFullYear() } = {}) {
  const size = [8, 10, 12, 14].includes(teams) ? teams : 12;
  return `${BASE}/${scoringFormat(scoring)}?teams=${size}&year=${year}&position=all`;
}

/** Their rows, in the shape the board loads. */
export function parseAdpFeed(payload) {
  const players = Array.isArray(payload?.players) ? payload.players : [];
  const out = [];
  for (const p of players) {
    const name = (p.name || "").trim();
    const adp = Number(p.adp);
    if (!name || !Number.isFinite(adp) || adp <= 0) continue;
    out.push({
      name,
      team: (p.team || "").toUpperCase(),
      pos: p.position || null,
      adp,
      bye: Number.isInteger(p.bye) ? p.bye : null,
      // How settled the market is on him: a wide spread is a disagreement,
      // which is worth keeping even though nothing reads it yet.
      stdev: Number.isFinite(Number(p.stdev)) ? Number(p.stdev) : null,
    });
  }
  return out.sort((a, b) => a.adp - b.adp);
}
