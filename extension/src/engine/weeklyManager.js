/* Weekly decisions use weekly, league-scored projections only. Draft ADP,
 * mock picks and the preseason player pool are deliberately not inputs. */
const ALIASES = { DST: "DEF", "D/ST": "DEF", PK: "K", "W/R/T": "FLEX", "Q/W/R/T": "SUPERFLEX", "W/R": "WRRB", "W/T": "WRTE" };
const ELIGIBLE = { FLEX: ["RB", "WR", "TE"], SUPERFLEX: ["QB", "RB", "WR", "TE"], WRRB: ["RB", "WR"], WRTE: ["WR", "TE"] };
const OUT = new Set(["O", "OUT", "IR", "IR-R", "PUP", "PUP-R", "NFI", "NFI-R", "SUSP", "NA"]);
const BENCH = new Set(["BN", "BE", "BENCH", "IR", "IR+"]);
export const position = (value) => ALIASES[String(value || "").trim().toUpperCase()] || String(value || "").trim().toUpperCase();
export const playerKey = (p) => `${String(p.name || "").toLowerCase().replace(/[^a-z0-9]/g, "")}:${position(p.pos)}`;
const round = (n) => Math.round(n * 100) / 100;
const number = (n) => typeof n === "number" && Number.isFinite(n);
const isStarter = (p) => p.slot && !BENCH.has(p.slot);
const fits = (p, slot) => (ELIGIBLE[slot] || [slot]).some((pos) => p.positions.includes(pos));
const unavailable = (p, week) => OUT.has(p.status) || p.bye === week || /^IR/.test(p.slot);

function normalize(players) {
  const seen = new Set();
  return players.map((p) => ({ ...p, pos: position(p.pos),
    positions: (p.positions || String(p.pos).split(",")).map(position),
    slot: position(p.slot), status: String(p.status || "").toUpperCase(),
  })).filter((p) => {
    const key = playerKey(p);
    if (!p.name || !p.pos || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function starterSlots(config) {
  const result = [];
  for (const [raw, count] of Object.entries(config.roster?.starters || {})) {
    const slot = position(raw);
    if (!Number.isInteger(count) || count < 0 || count > 10) throw new Error(`Invalid starter count for ${raw}.`);
    if (!["QB", "RB", "WR", "TE", "K", "DEF", ...Object.keys(ELIGIBLE)].includes(slot)) throw new Error(`Unsupported starter slot: ${raw}.`);
    for (let i = 0; i < count; i++) result.push(slot);
  }
  if (!result.length || result.length > 18) throw new Error("Set between 1 and 18 starting slots in League settings.");
  return result;
}

/* Dynamic programming finds the best whole lineup, including overlapping
 * flex eligibility. A greedy per-position sort fails for multi-position players.
 * Fill playable slots first, then maximize points, preserving ties in-place. */
export function optimizeLineup(roster, slots, week) {
  const fixed = Array(slots.length).fill(null);
  let fixedMask = 0;
  for (const p of roster.filter((p) => p.locked === true && isStarter(p))) {
    const i = slots.findIndex((slot, i) => slot === p.slot && !fixed[i]);
    if (i < 0) throw new Error(`Locked starter ${p.name} does not fit the configured lineup. Check League settings.`);
    fixed[i] = p;
    fixedMask |= 1 << i;
  }
  let states = new Map([[fixedMask, { points: 0, kept: 0, lineup: fixed }]]);
  for (const p of roster) {
    if (p.locked === true || unavailable(p, week) || !number(p.projected)) continue;
    const next = new Map(states);
    for (const [mask, state] of states) {
      for (let i = 0; i < slots.length; i++) {
        if ((mask & (1 << i)) || !fits(p, slots[i])) continue;
        const nextMask = mask | (1 << i);
        const points = state.points + p.projected;
        const kept = state.kept + (p.slot === slots[i] ? 1 : 0);
        const previous = next.get(nextMask);
        if (!previous || points > previous.points || (points === previous.points && kept > previous.kept)) {
          const lineup = [...state.lineup];
          lineup[i] = p;
          next.set(nextMask, { points, kept, lineup });
        }
      }
    }
    states = next;
  }
  const filled = (mask) => mask.toString(2).replace(/0/g, "").length;
  const best = [...states].sort((a, b) => filled(b[0]) - filled(a[0]) || b[1].points - a[1].points || b[1].kept - a[1].kept)[0][1];
  return { lineup: best.lineup.map((player, i) => ({ slot: slots[i], player })),
    projected: round(best.points), holes: best.lineup.filter((p) => !p).length };
}

export function buildWeeklyReport({ rosterSnapshot, waiverSnapshot, config, season, week, now = Date.now() }) {
  const report = { season, week, errors: [], warnings: [], alerts: [], lineup: [], starts: [], sits: [], waivers: [], projected: null };
  if (!Number.isInteger(week) || week < 1 || week > 18 || !Number.isInteger(season) || season < 2020) {
    report.errors.push("Choose the season and NFL week to manage.");
    return report;
  }
  let slots;
  try { slots = starterSlots(config); } catch (e) { report.errors.push(e.message); return report; }
  const check = (snapshot, label) => {
    const errors = [];
    if (!snapshot?.players?.length) return [`Import ${label} from Yahoo for this week.`];
    if (snapshot.week !== week || snapshot.season !== season) errors.push(`${label} belongs to another week or season. Import the selected week.`);
    if (!snapshot.leagueId) errors.push(`${label} has no league identity. Reimport from your league.`);
    if (snapshot.scoring !== config.league?.scoring) errors.push(`${label} scoring differs from League settings. Check settings and reimport.`);
    const age = now - Date.parse(snapshot.capturedAt);
    if (!Number.isFinite(age) || age > 24 * 3600000 || age < -300000) errors.push(`${label} is stale or has an invalid timestamp. Refresh before acting.`);
    return errors;
  };
  report.errors.push(...check(rosterSnapshot, "Your roster"));
  if (report.errors.length) return report;
  const roster = normalize(rosterSnapshot.players);
  report.rosterCount = roster.length;
  report.capturedAt = rosterSnapshot.capturedAt;
  const missing = roster.filter((p) => !number(p.projected) && !unavailable(p, week) && p.locked !== true);
  if (missing.length) report.warnings.push(`Missing weekly projections: ${missing.map((p) => p.name).join(", ")}. Lineup and waiver comparisons are provisional.`);
  if (roster.some((p) => !p.slot)) report.errors.push("Some roster slots could not be read. Import the full team table with current lineup slots.");
  if (roster.some((p) => p.locked == null)) report.warnings.push("Game lock times were not available for every player. Verify Yahoo still allows each change before acting.");
  for (const p of roster) {
    if (unavailable(p, week) && isStarter(p)) report.alerts.push(`${p.locked === true ? "Locked starter" : "Replace starter"}: ${p.name} — ${p.bye === week ? "bye week" : p.status || "IR slot"}.`);
    else if (["Q", "D", "GTD", "QUESTIONABLE", "DOUBTFUL"].includes(p.status)) report.alerts.push(`Monitor ${p.name} (${p.status}); keep a playable backup until game status is confirmed.`);
  }
  if (report.errors.length) return report;
  let best;
  try { best = optimizeLineup(roster, slots, week); } catch (e) { report.errors.push(e.message); return report; }
  Object.assign(report, best);
  if (best.holes) report.alerts.unshift(`${best.holes} starting slot(s) have no eligible player with a weekly projection.`);
  const chosen = new Set(best.lineup.filter((s) => s.player).map((s) => playerKey(s.player)));
  report.starts = roster.filter((p) => chosen.has(playerKey(p)) && !isStarter(p));
  report.sits = roster.filter((p) => !chosen.has(playerKey(p)) && isStarter(p) && p.locked !== true);
  const waiverErrors = check(waiverSnapshot, "Available players");
  if (waiverSnapshot && waiverSnapshot.leagueId !== rosterSnapshot.leagueId) waiverErrors.push("Available players are from a different league. Reimport from your team's league.");
  if (waiverErrors.length) {
    report.warnings.push(...waiverErrors);
    return report;
  }
  const mine = new Set(roster.map(playerKey));
  for (const p of normalize(waiverSnapshot.players)) {
    if (mine.has(playerKey(p)) || !["FA", "W"].includes(p.availability) || unavailable(p, week) || p.locked === true || !number(p.projected)) continue;
    const result = optimizeLineup([...roster, { ...p, slot: "BN" }], slots, week);
    const gain = round(result.projected - best.projected);
    if (result.holes < best.holes || gain > 0) report.waivers.push({ player: p, gain, fillsHole: result.holes < best.holes,
      slot: result.lineup.find((s) => s.player && playerKey(s.player) === playerKey(p))?.slot });
  }
  report.waivers.sort((a, b) => Number(b.fillsHole) - Number(a.fillsHole) || b.gain - a.gain);
  report.waivers = report.waivers.slice(0, 10);
  report.warnings.push("Waiver options are alternatives, each compared with your current roster. Only imported pages are covered; review roster space, claim timing and season value before dropping anyone.");
  return report;
}

export function formatWeeklyReport(report) {
  const lines = [`WEEK ${report.week} · ${report.season}`, report.capturedAt ? `Roster captured ${report.capturedAt}` : ""];
  if (report.errors.length) return [...lines, ...report.errors].filter(Boolean).join("\n");
  lines.push(...report.alerts, "", "RECOMMENDED LINEUP");
  for (const { slot, player: p } of report.lineup) lines.push(`${slot}: ${p ? `${p.name} (${p.locked === true ? "LOCKED" : p.projected + " projected"})` : "NEEDS COVERAGE"}`);
  if (report.starts.length) lines.push(`Start from bench: ${report.starts.map((p) => p.name).join(", ")}`);
  if (report.sits.length) lines.push(`Sit: ${report.sits.map((p) => p.name).join(", ")}`);
  lines.push("", "WAIVER OPTIONS");
  lines.push(...(report.waivers.length ? report.waivers.map(({ player: p, gain, fillsHole, slot }) => `${p.name} (${p.pos}, ${p.availability}) — ${fillsHole ? `fills ${slot}` : `+${gain.toFixed(2)} projected lineup points`}`) : ["No verified upgrade in the imported available-player pages."]));
  lines.push("", ...report.warnings);
  return lines.filter((line) => line !== undefined).join("\n");
}
