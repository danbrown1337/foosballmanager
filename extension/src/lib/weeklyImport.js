import { position, playerKey } from "../engine/weeklyManager.js";

const clean = (el) => (el?.textContent || "").replace(/\s+/g, " ").trim();
const STATUS = /^(Q|D|O|IR|IR-R|PUP|PUP-R|NFI|NFI-R|SUSP|NA|GTD)$/i;
const SLOT = /^(QB|RB|WR|TE|K|DEF|D\/ST|BN|BE|BENCH|IR\+?|FLEX|W\/R\/T|W\/R|W\/T|Q\/W\/R\/T|SUPERFLEX)$/i;
const decimal = (value) => /^-?\d+(?:\.\d+)?$/.test(value) ? Number(value) : null;

export function weeklyPageContext(url, kind, week, { selectedStat, deferStats = false } = {}) {
  const source = new URL(url);
  if (source.protocol !== "https:" || !/(^|\.)fantasysports\.yahoo\.com$/.test(source.hostname)) throw new Error("Open your Yahoo Fantasy Football league first.");
  const route = /^\/f1\/(\d+)\/(players|\d+)(?:\/team)?\/?$/.exec(source.pathname);
  if (!route || (kind === "roster" ? route[2] === "players" : route[2] !== "players")) throw new Error(kind === "roster" ? "Open your team's roster page, then import it." : "Open your league's Players page, then import it.");
  const stat = selectedStat ?? source.searchParams.get("stat1");
  const projectionWeek = /^S_PW_(\d+)$/.exec(stat || "");
  const urlWeek = source.searchParams.get("week");
  if ((projectionWeek && Number(projectionWeek[1]) !== week) || (urlWeek && Number(urlWeek) !== week)) throw new Error("The Yahoo page is showing a different week. Select the same week in Yahoo and Weekly.");
  // Season totals / actual stats must never masquerade as weekly forecasts.
  if (kind === "waivers" && !projectionWeek && !deferStats) throw new Error("On Yahoo Players, select this week's projected stats before importing (not season totals or actual points).");
  // Keep only query fields that describe this view, never session tokens.
  const safe = new URL(source.origin + source.pathname);
  for (const key of ["week", "stat1", "stat2", "status", "pos", "count", "sort", "sdir", "season"])
    if (source.searchParams.has(key)) safe.searchParams.set(key, source.searchParams.get(key));
  if (projectionWeek) safe.searchParams.set("stat1", stat);
  return { leagueId: route[1], teamId: kind === "roster" ? route[2] : null,
    sourceUrl: safe.href, projectionWeek: projectionWeek ? Number(projectionWeek[1]) : null,
    urlWeek: urlWeek ? Number(urlWeek) : null };
}

/* Header grid expansion handles Yahoo's grouped headers, colspans and
 * rowspans without hard-coding numeric columns. */
function headers(table) {
  const grid = [];
  [...table.querySelectorAll("thead tr")].forEach((row, r) => {
    grid[r] ||= [];
    let c = 0;
    for (const cell of row.children) {
      while (grid[r][c] != null) c++;
      const label = `${clean(cell)} ${cell.getAttribute("title") || ""}`.trim().toLowerCase();
      for (let dy = 0; dy < (Number(cell.getAttribute("rowspan")) || 1); dy++) {
        grid[r + dy] ||= [];
        for (let dx = 0; dx < (Number(cell.getAttribute("colspan")) || 1); dx++) grid[r + dy][c + dx] = label;
      }
      c += Number(cell.getAttribute("colspan")) || 1;
    }
  });
  const last = grid.at(-1) || [];
  return last.map((_, i) => [...new Set(grid.map((r) => r[i]).filter(Boolean))].join(" "));
}

export function parseWeeklyPage(doc, { url, kind, season, week, scoring, now = Date.now() }) {
  const context = weeklyPageContext(url, kind, week, { selectedStat: doc.querySelector('select[name="stat1"]')?.value });
  const selected = [...doc.querySelectorAll("select option:checked, [aria-current='page'], .selected, .active, h1, h2")].map(clean);
  const selectedWeeks = selected.map((t) => /^Week\s+(\d+)$/i.exec(t)?.[1]).filter(Boolean).map(Number);
  for (const caption of doc.querySelectorAll("table caption")) {
    const match = /roster for week\s+(\d+)\b/i.exec(clean(caption));
    if (match) selectedWeeks.push(Number(match[1]));
  }
  if (selectedWeeks.some((w) => w !== week)) throw new Error("Yahoo's selected week differs from Weekly. Match the week before importing.");
  if (!context.projectionWeek && !context.urlWeek && !selectedWeeks.includes(week)) throw new Error("Cannot verify the page's week. Select the week in Yahoo so it appears in the page or URL.");
  const urlSeason = new URL(url).searchParams.get("season");
  if (urlSeason && Number(urlSeason) !== season) throw new Error("Yahoo's season differs from the selected season.");
  const players = [];
  const seen = new Set();
  for (const table of doc.querySelectorAll("table")) {
    const cols = headers(table);
    const projectionCol = cols.findIndex((h) => /proj(?:ected|ection)?[ .]*(?:pts|points)|projected.*fan pts/.test(h));
    const fanCol = cols.findIndex((h) => /fan(?:tasy)?\.?\s*(?:pts|points)/.test(h));
    const projectedIndex = projectionCol >= 0 ? projectionCol : context.projectionWeek ? fanCol : -1;
    const slotCol = cols.findIndex((h) => /^(pos|position|slot)(?:\s+\1)?$/.test(h));
    const byeCol = cols.findIndex((h) => /^bye(?: bye)?$/.test(h));
    const statusCol = cols.findIndex((h) => /^(roster status|status|availability)(?:\s+\1)?$/.test(h));
    const opponentCol = cols.findIndex((h) => /^(opp|opponent)(?:\s+\1)?$/.test(h));
    for (const tr of table.querySelectorAll("tbody tr")) {
      const container = tr.querySelector(".ysf-player-name");
      const link = container?.querySelector("a");
      if (!link) continue;
      const name = clean(link);
      const info = [...container.querySelectorAll("span, div, em")].map(clean);
      const teamPos = info.map((v) => /^([A-Za-z.]{2,4})\s*-\s*([A-Z]{1,3}(?:\s*,\s*[A-Z]{1,3})*)$/.exec(v)).find(Boolean);
      if (!teamPos) throw new Error(`Could not read ${name}'s team and position; saved data was kept.`);
      const identity = { name, playerId: link.getAttribute("data-ys-playerid"), team: teamPos[1].toUpperCase(), pos: position(teamPos[2].split(",")[0]) };
      const key = playerKey(identity);
      if (seen.has(key)) continue;
      const cells = [...tr.children];
      const slotSelect = tr.querySelector("select");
      const slotText = slotSelect ? clean(slotSelect.selectedOptions?.[0]) : clean(cells[slotCol]);
      const slot = SLOT.test(slotText) ? position(slotText) : "";
      if (kind === "roster" && !slot) throw new Error(`Could not read ${name}'s lineup slot. Open the full roster table, then retry.`);
      const availabilityText = clean(cells[statusCol]).toUpperCase();
      const availability = /^FA\b/.test(availabilityText) ? "FA" : /^W(?:\b|\()/.test(availabilityText) ? "W" : null;
      const game = clean(cells[opponentCol]);
      const start = tr.querySelector("time[datetime]")?.getAttribute("datetime");
      const kickoff = start ? Date.parse(start) : NaN;
      const locked = /\b(final|in progress|halftime|[1-4](?:st|nd|rd|th)\s+qtr)\b/i.test(game) ? true : Number.isFinite(kickoff) ? kickoff <= now : null;
      const byeValue = Number(clean(cells[byeCol]));
      const bye = /\bbye\b/i.test(game) ? week : byeValue >= 1 && byeValue <= 18 ? byeValue : null;
      const status = info.find((s) => STATUS.test(s))?.toUpperCase() || "";
      players.push({ ...identity,
        positions: teamPos[2].split(",").map(position), slot: kind === "roster" ? slot : "BN",
        status, bye, locked, projected: projectedIndex >= 0 ? decimal(clean(cells[projectedIndex])) : null,
        availability: kind === "waivers" ? availability : null,
        availabilityDetail: kind === "waivers" ? clean(cells[statusCol]) : null });
      seen.add(key);
    }
  }
  if (!players.length) throw new Error("No player rows found. Sign into Yahoo and open the full table; existing imports were kept.");
  if (players.every((p) => p.projected == null)) throw new Error("No weekly projection column found. Select weekly projected points in Yahoo; existing imports were kept.");
  if (kind === "waivers" && !players.some((p) => p.availability)) throw new Error("No verified available players found. Select Available Players in Yahoo and retry.");
  return { kind, season, week, scoring, ...context, capturedAt: new Date(now).toISOString(), players };
}

export function mergeWaiverPages(previous, incoming) {
  const same = previous?.season === incoming.season && previous?.week === incoming.week && previous?.leagueId === incoming.leagueId && previous?.scoring === incoming.scoring;
  const pages = same ? { ...(previous.pages || {}) } : {};
  pages[incoming.sourceUrl] = incoming;
  // Each row retains the freshness of its page. A newly imported page cannot
  // make an old page fresh, and refreshing one page replaces its old rows.
  const all = Object.values(pages).sort((a, b) => Date.parse(a.capturedAt) - Date.parse(b.capturedAt));
  const byPlayer = new Map();
  for (const page of all) for (const p of page.players) byPlayer.set(playerKey(p), p);
  return { ...incoming, capturedAt: all[0].capturedAt, players: [...byPlayer.values()], pages };
}
