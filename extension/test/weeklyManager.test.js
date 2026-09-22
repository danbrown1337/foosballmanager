import test from "node:test";
import assert from "node:assert/strict";
import { buildWeeklyReport, optimizeLineup, starterSlots, formatWeeklyReport } from "../src/engine/weeklyManager.js";
import { weeklyPageContext, mergeWaiverPages } from "../src/lib/weeklyImport.js";

const now = Date.parse("2026-09-22T12:00:00Z");
const config = { league: { scoring: "ppr" }, roster: { starters: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 2, DEF: 1 } } };
const player = (name, pos, projected, slot = pos, rest = {}) => ({ name, pos, projected, slot, positions: [pos], status: "", bye: 9, locked: false, ...rest });
const snapshot = (players, rest = {}) => ({ players, leagueId: "123", season: 2026, week: 3, scoring: "ppr", capturedAt: new Date(now).toISOString(), ...rest });
const roster = [player("Quarterback", "QB", 21), player("Out Back", "RB", 18, "RB", { status: "O" }), player("Healthy Back", "RB", 15), player("Wide One", "WR", 17), player("Wide Two", "WR", 16), player("Tight End", "TE", 12), player("Flex One", "WR", 10, "FLEX"), player("Flex Two", "RB", 9, "FLEX"), player("Defense", "DEF", 6), player("Bench Back", "RB", 14, "BN"), player("Bench Wide", "WR", 13, "BN")];
const report = (overrides = {}) => buildWeeklyReport({ config, rosterSnapshot: snapshot(roster), waiverSnapshot: snapshot([]), week: 3, season: 2026, now, ...overrides });

test("replaces an out starter and allocates both flex spots without duplicating players", () => {
  const r = report();
  assert.equal(r.lineup.length, 9);
  assert.equal(r.holes, 0);
  assert.equal(r.lineup.filter((s) => s.slot === "FLEX").length, 2);
  assert.equal(new Set(r.lineup.map((s) => s.player.name)).size, 9);
  assert.ok(r.starts.some((p) => p.name === "Bench Back"));
  assert.ok(r.sits.some((p) => p.name === "Out Back"));
  assert.ok(r.alerts.some((a) => a.includes("Replace starter: Out Back")));
});
test("overlapping eligibility uses the best entire lineup, not greedy assignment", () => {
  const players = [player("Dual", "TE", 20, "BN", { positions: ["TE", "QB"] }), player("Tight", "TE", 19, "TE"), player("QB", "QB", 5, "QB")];
  const r = optimizeLineup(players, ["TE", "QB"], 3);
  assert.equal(r.projected, 39);
  assert.equal(r.lineup[0].player.name, "Tight");
  assert.equal(r.lineup[1].player.name, "Dual");
});
test("preserves locked starters and never moves a locked bench player", () => {
  const r = optimizeLineup([player("Locked starter", "RB", 0, "RB", { locked: true, status: "O" }), player("Locked bench", "RB", 30, "BN", { locked: true }), player("Replacement", "RB", 12, "BN")], ["RB", "FLEX"], 3);
  assert.equal(r.lineup[0].player.name, "Locked starter");
  assert.equal(r.lineup[1].player.name, "Replacement");
});
test("a locked starter incompatible with settings blocks advice", () => {
  const r = report({ rosterSnapshot: snapshot([player("Kicker", "K", 6, "K", { locked: true })]) });
  assert.match(r.errors.join(" "), /Locked starter.*League settings/);
});
test("bye, IR, suspended players and healthy players still in IR are excluded", () => {
  const bad = [{ bye: 3 }, { status: "IR" }, { status: "SUSP" }, { slot: "IR" }].map((x, i) => player(`Bad ${i}`, "RB", 30, "BN", x));
  const r = optimizeLineup([...bad, player("Good", "RB", 1, "BN")], ["RB", "FLEX"], 3);
  assert.equal(r.holes, 1);
  assert.equal(r.lineup.filter((s) => s.player)[0].player.name, "Good");
});
test("questionable players remain eligible and get a monitoring alert", () => {
  const r = report({ rosterSnapshot: snapshot([player("Questionable", "QB", 20, "QB", { status: "Q" })]) });
  assert.ok(r.alerts.some((a) => a.includes("Monitor Questionable")));
  assert.equal(r.lineup[0].player.name, "Questionable");
});
test("missing projection is never treated as preseason ADP or numeric zero", () => {
  const r = report({ rosterSnapshot: snapshot([player("Unknown", "QB", null, "QB", { adp: 1 })]) });
  assert.equal(r.lineup[0].player, null);
  assert.match(r.warnings.join(" "), /Missing weekly projections: Unknown/);
});
test("zero and negative real projections are valid and preserve roster coverage", () => {
  const r = optimizeLineup([player("Zero", "QB", 0), player("Negative", "DEF", -1)], ["QB", "DEF"], 3);
  assert.equal(r.holes, 0);
  assert.equal(r.projected, -1);
});
test("unknown lock status is visible instead of silently claiming players can move", () => {
  assert.match(report({ rosterSnapshot: snapshot([player("Unknown", "QB", 20, "QB", { locked: null })]) }).warnings.join(" "), /Game lock times/);
});
for (const [label, change] of Object.entries({ stale: { capturedAt: "2026-09-20T00:00:00Z" }, future: { capturedAt: "2026-09-30T00:00:00Z" }, week: { week: 2 }, season: { season: 2025 }, scoring: { scoring: "standard" }, identity: { leagueId: null } })) {
  test(`${label} roster data blocks lineup advice`, () => {
    const r = report({ rosterSnapshot: snapshot(roster, change) });
    assert.ok(r.errors.length);
    assert.equal(r.lineup.length, 0);
  });
}
test("waivers require positive availability and cannot include my players", () => {
  const pool = [player("Owned elsewhere", "RB", 40), player("Unknown ownership", "RB", 50), player("Bench Back", "RB", 60, "BN", { availability: "FA" }), player("Free upgrade", "RB", 22, "BN", { availability: "FA" }), player("Claim upgrade", "WR", 20, "BN", { availability: "W" }), player("Out waiver", "RB", 99, "BN", { availability: "FA", status: "O" })];
  const r = report({ waiverSnapshot: snapshot(pool) });
  assert.deepEqual(r.waivers.map((w) => w.player.name), ["Free upgrade", "Claim upgrade"]);
  assert.ok(r.waivers.every((w) => w.gain > 0));
});
test("waivers prefer filling an empty starting slot over a smaller upgrade", () => {
  const r = report({ rosterSnapshot: snapshot([player("QB", "QB", 20)]), waiverSnapshot: snapshot([player("QB upgrade", "QB", 21, "BN", { availability: "FA" }), player("Fill RB", "RB", 5, "BN", { availability: "W" })]) });
  assert.equal(r.waivers[0].player.name, "Fill RB");
  assert.equal(r.waivers[0].fillsHole, true);
});
test("wrong-league and stale waivers do not contaminate a valid lineup", () => {
  for (const extra of [{ leagueId: "999" }, { capturedAt: "2026-09-20T00:00:00Z" }]) {
    const r = report({ waiverSnapshot: snapshot([player("FA", "RB", 40, "BN", { availability: "FA" })], extra) });
    assert.equal(r.waivers.length, 0);
    assert.equal(r.lineup.length, 9);
    assert.ok(r.warnings.length);
  }
});
test("supports superflex and Yahoo flex aliases; no kicker without a slot", () => {
  const slots = starterSlots({ roster: { starters: { "W/R/T": 2, "Q/W/R/T": 1 } } });
  const r = optimizeLineup([player("QB", "QB", 30), player("RB", "RB", 20), player("WR", "WR", 15), player("K", "K", 100)], slots, 3);
  assert.equal(r.projected, 65);
});
test("duplicate imports cannot fill multiple slots with the same player", () => {
  const r = report({ rosterSnapshot: snapshot([player("A.J. Brown", "WR", 20), player("AJ Brown", "WR", 20)]) });
  assert.equal(r.lineup.filter((s) => s.player).length, 1);
});
test("report copy includes problems, concrete lineup and data limitations", () => {
  const text = formatWeeklyReport(report());
  assert.match(text, /WEEK 3.*2026/);
  assert.match(text, /Replace starter/);
  assert.match(text, /RECOMMENDED LINEUP/);
  assert.match(text, /Import Available players/);
});
test("weekly page checks reject season stats, wrong weeks, other hosts and draft rooms", () => {
  const base = "https://football.fantasysports.yahoo.com/f1/123/";
  for (const url of [base + "players?stat1=S_P", base + "players?stat1=S_PW_2", "https://evil.example/f1/123/players?stat1=S_PW_3", "https://football.fantasysports.yahoo.com/draftclient/f1/123/4"]) assert.throws(() => weeklyPageContext(url, "waivers", 3));
  const r = weeklyPageContext(base + "players?stat1=S_PW_3&auth=private", "waivers", 3);
  assert.equal(r.leagueId, "123");
  assert.ok(!r.sourceUrl.includes("private"));
});
test("waiver page merge retains oldest capture time and replaces refreshed pages", () => {
  const first = snapshot([player("A", "WR", 10)], { sourceUrl: "one", capturedAt: "2026-09-21T00:00:00Z" });
  let pool = mergeWaiverPages(null, first);
  pool = mergeWaiverPages(pool, snapshot([player("B", "RB", 15)], { sourceUrl: "two" }));
  assert.equal(pool.capturedAt, first.capturedAt);
  pool = mergeWaiverPages(pool, snapshot([player("C", "TE", 8)], { sourceUrl: "one" }));
  assert.deepEqual(pool.players.map((p) => p.name).sort(), ["B", "C"]);
  assert.equal(pool.capturedAt, new Date(now).toISOString());
  const nextWeek = mergeWaiverPages(pool, snapshot([player("D", "QB", 20)], { sourceUrl: "three", week: 4 }));
  assert.equal(nextWeek.players.length, 1);
});
