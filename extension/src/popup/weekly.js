import { Storage } from "../lib/storage.js";
import { buildWeeklyReport, formatWeeklyReport } from "../engine/weeklyManager.js";
import { mergeWaiverPages, parseWeeklyPage, weeklyPageContext } from "../lib/weeklyImport.js";

const el = (id) => document.getElementById(id);
let state = {};
let busy = false;
let text = "";
function period() {
  const season = Number(el("weeklySeason").value), week = Number(el("weeklyWeek").value);
  if (!Number.isInteger(season) || season < 2020 || season > 2100 || !Number.isInteger(week) || week < 1 || week > 18) throw new Error("Select the season and week first.");
  return { season, week };
}
async function options(kind) {
  if ((await Storage.getPractice()).active) throw new Error("Turn off Practice mode in Settings before managing your real team.");
  const config = await Storage.getConfig();
  return { ...period(), kind, scoring: config.league.scoring };
}
async function render() {
  if ((await Storage.getPractice()).active) {
    text = "Turn off Practice mode in Settings before managing your real team.";
    el("weeklyReport").textContent = text;
    return;
  }
  const config = await Storage.getConfig();
  const starters = Object.entries(config.roster.starters).filter(([, n]) => n).map(([s, n]) => `${n} ${s}`).join(" · ");
  el("weeklyLeague").textContent = `${config.league.name} · ${config.league.scoring} · ${starters}`;
  text = formatWeeklyReport(buildWeeklyReport({ ...period(), config, rosterSnapshot: state.roster, waiverSnapshot: state.waivers }));
  el("weeklyReport").textContent = text;
}
async function run(action) {
  if (busy) return;
  busy = true;
  document.querySelectorAll(".weekly-actions button").forEach((b) => b.disabled = true);
  try { await action(); }
  catch (err) { el("weeklyStatus").textContent = err.message; }
  finally {
    busy = false;
    document.querySelectorAll(".weekly-actions button").forEach((b) => b.disabled = false);
  }
}
async function save(next) {
  // Persist before replacing UI state, so a storage failure keeps the previous report.
  await Storage.setWeekly(next);
  state = next;
  await render();
}
async function capture(kind) {
  const opts = await options(kind);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  weeklyPageContext(tab?.url || "", kind, opts.week);
  el("weeklyStatus").textContent = "Reading the current Yahoo page…";
  let response;
  try { response = await chrome.tabs.sendMessage(tab.id, { type: "CAPTURE_WEEKLY_PAGE", options: opts }); }
  catch { throw new Error("Refresh this Yahoo tab after updating the extension, then import again."); }
  if (!response?.ok) throw new Error(response?.error || "Could not read the Yahoo page.");
  const snapshot = response.snapshot;
  if (kind === "waivers" && state.roster && snapshot.leagueId !== state.roster.leagueId) throw new Error("These players belong to another league. Open your team's league.");
  const next = { ...state, ...period() };
  if (kind === "roster") {
    if (state.roster && (state.roster.leagueId !== snapshot.leagueId || state.roster.teamId !== snapshot.teamId)) next.waivers = null;
    next.roster = snapshot;
  } else next.waivers = mergeWaiverPages(state.waivers, snapshot);
  await save(next);
  el("weeklyStatus").textContent = `Imported ${snapshot.players.length} players · league ${snapshot.leagueId} · week ${snapshot.week} · ${new Date(snapshot.capturedAt).toLocaleString()}`;
}
el("weeklyRoster").addEventListener("click", () => run(() => capture("roster")));
el("weeklyWaivers").addEventListener("click", () => run(() => capture("waivers")));
el("weeklyRefresh").addEventListener("click", () => run(async () => {
  const opts = await options("roster");
  if (!state.roster) throw new Error("Import your team once before refreshing saved pages.");
  const sources = [state.roster, ...Object.values(state.waivers?.pages || {})];
  if (sources.some((s) => s.week !== opts.week || s.season !== opts.season)) throw new Error("New week selected. Open that week in Yahoo and import it first.");
  el("weeklyStatus").textContent = "Refreshing saved Yahoo pages…";
  const snapshots = await Promise.all(sources.map(async (source) => {
    weeklyPageContext(source.sourceUrl, source.kind, opts.week);
    const response = await fetch(source.sourceUrl, { credentials: "include", signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`Yahoo returned ${response.status}; previous imports were kept.`);
    return parseWeeklyPage(new DOMParser().parseFromString(await response.text(), "text/html"), { ...opts, kind: source.kind, url: response.url });
  }));
  let waivers = null;
  for (const page of snapshots.slice(1)) waivers = mergeWaiverPages(waivers, page);
  await save({ ...state, ...period(), roster: snapshots[0], waivers });
  el("weeklyStatus").textContent = `Refreshed ${snapshots.length} page(s) at ${new Date().toLocaleTimeString()}.`;
}));
el("weeklyCopy").addEventListener("click", () => run(async () => {
  await render();
  await navigator.clipboard.writeText(text);
  el("weeklyStatus").textContent = "Copied the weekly report.";
}));
for (const id of ["weeklyWeek", "weeklySeason"]) el(id).addEventListener("change", () => run(async () => {
  await save({ ...state, ...period() });
  el("weeklyStatus").textContent = "Selected week saved. Import this week if the report asks for fresh data.";
}));
run(async () => {
  state = await Storage.getWeekly();
  el("weeklySeason").value = state.season || new Date().getFullYear();
  el("weeklyWeek").value = state.week || "";
  if (state.week) {
    await render();
    if (state.roster) el("weeklyStatus").textContent = `Saved roster: ${new Date(state.roster.capturedAt).toLocaleString()} · use Refresh saved pages for current data.`;
    document.querySelector('[data-tab="weekly"]').click();
  } else el("weeklyReport").textContent = "Choose your NFL week, then import your team. No preseason rankings are used in this report.";
});
