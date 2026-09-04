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

/* The designation Yahoo prints beside a name. The ones that mean "not playing
 * this season" matter most: a player on PUP-R or IR is a wasted roster spot,
 * and without this he is just another name on the board — one was queued. */
const STATUS_TAGS = /^(Q|D|O|SUSP|IR|IR-R|PUP|PUP-R|NFI|NFI-R|NA|COV)$/i;

/* Which column holds what, from the table's own header row. Guessing by value
 * doesn't work — games played is 16 or 17, indistinguishable from a bye week —
 * and fixed positions shift when a row carries a note or an injury tag, which
 * is how a passing-yards figure (2055) became a player's rank. */
function columnIndex(doc, label, fallback) {
  const rows = [...doc.querySelectorAll("table thead tr")];
  const cells = rows.length ? [...rows[rows.length - 1].children] : [];
  const i = cells.findIndex((th) => (th.textContent || "").trim().toLowerCase() === label);
  return i >= 0 ? i : fallback;
}

export function parsePoolPage(html, DomParser = DOMParser) {
  const doc = new DomParser().parseFromString(html, "text/html");
  const byeCol = columnIndex(doc, "bye", 5);
  const players = [];
  for (const tr of doc.querySelectorAll("table tbody tr")) {
    const container = tr.querySelector(".ysf-player-name");
    const link = container?.querySelector("a");
    if (!link) continue;

    let team = null;
    let pos = null;
    let status = null;
    for (const el of container.querySelectorAll("span, div, em")) {
      const value = (el.textContent || "").trim();
      if (!status && STATUS_TAGS.test(value)) status = value.toUpperCase();
      const m = TEAM_POS.exec(value);
      if (m) {
        team = m[1].toUpperCase();
        pos = m[2].split(",")[0];
      }
    }
    /* Cell positions are not stable — a player note, an injury tag or a
     * roster-status column shifts them — so a passing-yards figure was being
     * read as a rank, and 2055 turned up as a player's ADP. Take only values
     * that can be recognised for what they are: a bye is a week number, and
     * ranking comes from the order the list is already sorted in. */
    const cells = [...tr.children].map((td) => (td.textContent || "").trim());
    const byeValue = Number(cells[byeCol]);
    const bye = Number.isInteger(byeValue) && byeValue >= 1 && byeValue <= 18 ? byeValue : null;
    players.push({ name: link.textContent.trim(), team, pos, bye, status });
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
  /* Rank is position in the list, not a column: the pages are requested in
   * the league's own sort order, so row order is the ranking. */
  const byName = new Map();
  for (const html of htmls) {
    for (const p of parsePoolPage(html)) {
      if (p.name && !byName.has(p.name)) byName.set(p.name, { ...p, rank: byName.size + 1 });
    }
  }
  return [...byName.values()];
}
