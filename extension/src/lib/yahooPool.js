/*
 * Build the player pool from Yahoo's own league player list.
 *
 * The bundled ADP file is a snapshot compiled before the season, and it has
 * been wrong in ways nothing here could work around: both Robinsons listed as
 * RB ATL, so no amount of context could tell "B. Robinson" apart. Yahoo's list
 * is the league's own view — full names, current team, position, bye week,
 * projected points and its own rank — and it is fetched with the user's
 * session by the page itself, so it stays current without anyone maintaining
 * a CSV.
 *
 * Parsing targets .ysf-player-name rather than the row's text: a regex over
 * the whole cell turned "Amon-Ra St. Brown" into team "Amon" and "A.J. Brown"
 * into the wrong team entirely.
 */

const TEAM_POS = /^\s*([A-Za-z.]{2,4})\s*-\s*([A-Z]{1,3}(?:,[A-Z]{1,3})*)\s*$/;

export function parsePoolPage(html, DomParser = DOMParser) {
  const doc = new DomParser().parseFromString(html, "text/html");
  const players = [];
  for (const tr of doc.querySelectorAll("table tbody tr")) {
    const container = tr.querySelector(".ysf-player-name");
    const link = container?.querySelector("a");
    if (!link) continue;

    let team = null;
    let pos = null;
    for (const el of container.querySelectorAll("span, div, em")) {
      const m = TEAM_POS.exec(el.textContent || "");
      if (m) {
        team = m[1].toUpperCase();
        pos = m[2].split(",")[0];
        break;
      }
    }
    const cells = [...tr.children].map((td) => (td.textContent || "").trim());
    players.push({
      name: link.textContent.trim(),
      team,
      pos,
      bye: Number(cells[5]) || null,
      proj: Number(cells[6]) || null,
      rank: Number(cells[7]) || null,
    });
  }
  return players;
}

/** League id from any fantasysports URL: /f1/<id>/… or /draftclient/f1/<id>/… */
export function leagueIdFromUrl(url) {
  return (/\/f1\/(\d+)(?:\/|$)/.exec(url) || [])[1] || null;
}

/* Pages are fetched in parallel and merged by rank. `get` is injected so this
 * is testable without a browser, and so the caller decides how requests are
 * made from its own context. */
export async function fetchPool(leagueId, { get, pages = 10, perPage = 25 } = {}) {
  const counts = Array.from({ length: pages }, (_, i) => i * perPage);
  const htmls = await Promise.all(counts.map((c) => get(`/f1/${leagueId}/players?count=${c}`)));
  const byName = new Map();
  for (const html of htmls) {
    for (const p of parsePoolPage(html)) {
      if (p.name && !byName.has(p.name)) byName.set(p.name, p);
    }
  }
  return [...byName.values()].sort((a, b) => (a.rank ?? 9999) - (b.rank ?? 9999));
}
