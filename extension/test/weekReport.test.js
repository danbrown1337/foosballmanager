/*
 * The weekly panels end to end, minus Chrome.
 *
 * background.js's weekReport() and waiverReport() are the seam between three
 * things that are each tested on their own — the content script's page text,
 * weeklyParse.js, and weekly.js — and a seam is exactly where a port stops
 * being covered by its parts.
 *
 * These call the shipped composition rather than a copy of it: everything but
 * the chrome.* calls lives in lib/weeklyReport.js, so the only thing reproduced
 * below is the tab read itself. The shape assertions name every field popup.js
 * reads, because a renamed field breaks the panel silently.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { classifyWeeklyPage, parseWeeklyText } from "../src/lib/weeklyParse.js";
import { buildWaiverReport, buildWeekReport } from "../src/lib/weeklyReport.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = (name) =>
  readFileSync(join(HERE, "..", "..", "tests", "fixtures", name), "utf-8");

const NOW = new Date("2026-09-24T12:00:00Z");

/** What readYahooPages() returns: each open tab's text parsed and classified,
 * with the ones that carry no players dropped. */
function pagesFrom(...texts) {
  const pages = [];
  texts.forEach((text, i) => {
    const rows = parseWeeklyText(text);
    if (!rows.length) return;
    pages.push({
      rows,
      url: `https://football.fantasysports.yahoo.com/f1/799857/${i}`,
      kind: classifyWeeklyPage(rows),
    });
  });
  return { pages, tabCount: texts.length };
}

const buildReport = (text, config) => buildWeekReport(pagesFrom(text), config, NOW);

const NO_KICKER = {
  league: { superflex: false },
  roster: { starters: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 2, DEF: 1 } },
  season: { week1_start: "2026-09-10" },
};
const KICKER = {
  league: { superflex: false },
  roster: { starters: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DEF: 1 } },
  season: { week1_start: "2026-09-10" },
};

describe("week report over the captured week-1 page", () => {
  const report = buildReport(fixture("yahoo_myteam_week1.txt"), NO_KICKER);

  test("fills every slot and totals what Yahoo's own page totalled", () => {
    assert.equal(report.starters.length, 9);
    assert.ok(report.starters.every((s) => s.name));
    // Yahoo displayed 120.96 for the lineup it had set; the engine's own best
    // is that plus the one upgrade it found.
    assert.equal(report.projected, 121.7);
  });

  test("carries every field the popup renders", () => {
    for (const slot of report.starters) {
      assert.deepEqual(
        Object.keys(slot).sort(),
        ["emptyReason", "name", "opponent", "pos", "proj", "slot", "status"]);
    }
    for (const change of report.changes) {
      assert.deepEqual(
        Object.keys(change).sort(), ["bench", "moveOnly", "reason", "slot", "start"]);
    }
    assert.equal(typeof report.hasProjections, "boolean");
    assert.equal(typeof report.label, "string");
  });

  test("reports the real upgrade it found", () => {
    const swap = report.changes.find((c) => c.start === "Josh Downs");
    assert.ok(swap, "expected the Downs-for-Tuten flex upgrade");
    assert.equal(swap.bench, "Bhayshul Tuten");
    assert.match(swap.reason, /\+0\.74/);
  });

  test("knows it has projections", () => {
    assert.equal(report.hasProjections, true);
  });
});

describe("week report over the kicker page", () => {
  const report = buildReport(fixture("yahoo_myteam_week5_kicker.txt"), KICKER);

  test("starts the kicker and totals correctly", () => {
    const k = report.starters.find((s) => s.slot === "K");
    assert.equal(k.name, "Harrison Butker");
    assert.equal(report.projected, 109.3);
  });

  test("surfaces the Out and bye starters as warnings", () => {
    const warned = report.warnings.join(" ");
    assert.match(warned, /Bijan Robinson/);
    assert.match(warned, /Nico Collins/);
  });

  test("a league with no kicker slot leaves the kicker on the bench", () => {
    const noK = buildReport(fixture("yahoo_myteam_week5_kicker.txt"), NO_KICKER);
    assert.ok(!noK.starters.some((s) => s.name === "Harrison Butker"));
    assert.ok(noK.bench.some((p) => p.name === "Harrison Butker"));
  });

  test("empty slots carry a reason rather than rendering blank", () => {
    // A league needing more starters than the roster can fill.
    const thin = buildReport(fixture("yahoo_myteam_week5_kicker.txt"), {
      roster: { starters: { QB: 3, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DEF: 1 } },
    });
    const empty = thin.starters.filter((s) => !s.name);
    assert.ok(empty.length > 0);
    assert.ok(empty.every((s) => s.emptyReason));
  });
});

describe("degraded inputs", () => {
  test("a page with no roster on it reports a reason, not an empty lineup", () => {
    // A signed-out or still-loading page parses to nothing. Nine empty slots
    // would read as a lineup problem; the cause is that nothing was read.
    const report = buildReport("Yahoo Sports\nSign in\n", NO_KICKER);
    assert.match(report.error, /no roster on it/);
    assert.equal(report.starters, undefined);
  });

  test("no Yahoo tab at all says so specifically", () => {
    const report = buildWeekReport({ pages: [], tabCount: 0 }, NO_KICKER, NOW);
    assert.match(report.error, /Open your Yahoo My Team page/);
  });

  test("hasProjections is false when the page carried none", () => {
    // The league-rosters page renders names but no weekly numbers.
    const report = buildReport("BN Josh Allen Buf - QB\nBN Bijan Robinson Atl - RB\n",
      NO_KICKER);
    assert.equal(report.hasProjections, false);
    // Players still get slotted — on eligibility alone, which the panel says.
    assert.ok(report.starters.some((s) => s.name === "Josh Allen"));
  });
});

/* --- Waiver targets ------------------------------------------------------ */

const FAAB = {
  ...NO_KICKER,
  waivers: { system: "faab", faab_budget: 100, faab_remaining: 100 },
};
const PRIORITY = { ...NO_KICKER, waivers: { system: "priority" } };

const MY_TEAM = fixture("yahoo_myteam_week1.txt");
const WIRE = fixture("yahoo_players_available_week1.txt");

const waivers = (config, ...texts) =>
  buildWaiverReport(pagesFrom(...texts), config, { today: NOW });

describe("waiver report over the two captured pages", () => {
  const report = waivers(FAAB, MY_TEAM, WIRE);

  test("finds the roster and the wire without being told which tab is which", () => {
    // The point of classifying on content: the tabs arrive in whatever order
    // the user opened them, and both pages live under the same /f1/ URL shape.
    assert.equal(report.error, undefined);
    assert.equal(report.poolSize, 8);
    assert.equal(report.hasProjections, true);
  });

  test("tab order does not change the answer", () => {
    const flipped = waivers(FAAB, WIRE, MY_TEAM);
    assert.deepEqual(flipped.targets, report.targets);
  });

  test("carries every field the popup renders", () => {
    assert.ok(report.targets.length);
    for (const target of report.targets) {
      assert.deepEqual(Object.keys(target).sort(), [
        "bidHigh", "bidLow", "clears", "drop", "freeAgent", "gain", "name",
        "note", "pos", "proj", "rationale", "replaces", "rosterStatus",
        "status", "team", "worthPriority",
      ]);
    }
    assert.equal(typeof report.system, "string");
    assert.equal(typeof report.label, "string");
  });

  test("keeps 'add now' and 'claim by' apart, per player", () => {
    // The two are different actions on different clocks. Collapsing them into
    // "available" hands someone a deadline they don't have, or hides one.
    const tucker = report.targets.find((t) => t.name === "Tre Tucker");
    assert.equal(tucker.rosterStatus, "FA");
    assert.equal(tucker.freeAgent, true);
    assert.equal(tucker.clears, null);

    const darnold = report.targets.find((t) => t.name === "Sam Darnold");
    assert.equal(darnold.rosterStatus, "W (Sep 16)");
    assert.equal(darnold.freeAgent, false);
    assert.equal(darnold.clears, "Sep 16");
  });

  test("measures each target against the starter he would actually replace", () => {
    // Not against the rest of the wire, and not against the roster's best.
    const henry = report.targets.find((t) => t.name === "Hunter Henry");
    assert.equal(henry.replaces, "Kyle Pitts Sr.");
    assert.equal(henry.gain, -2.33);
  });

  test("prices nothing that would not upgrade a slot", () => {
    // Every gain on this pairing is negative, so no FAAB band applies. A bid
    // range on a downgrade is worse than no advice.
    assert.ok(report.targets.every((t) => t.gain <= 0));
    assert.ok(report.targets.every((t) => t.bidLow === null && t.bidHigh === null));
    assert.ok(report.targets.every((t) => t.worthPriority === false));
  });

  test("ranks by gain, best first", () => {
    const gains = report.targets.map((t) => t.gain);
    assert.deepEqual(gains, [...gains].sort((a, b) => b - a));
  });
});

describe("waiver pricing", () => {
  // A wire with a real upgrade on it, in the captured page's own column order
  // (Roster Status, GP*, Bye, then the projection). The captured roster's
  // weakest RB-eligible starter projects about 11.5, so this clears it well.
  // No slot label anywhere, which is what makes it a wire page and not a team.
  const upgrade = "\n\nStar Waiver Add\n"
    + "Star Waiver AddVideo ForecastNo new player Notes\n"
    + "KC - RB\nSun 1:00 pm vs Den\nFA\n1\n6\n24.50\n142\n168\n55%\n";

  test("a FAAB league gets a bid range out of what is left", () => {
    const report = waivers(FAAB, MY_TEAM, upgrade);
    const target = report.targets.find((t) => t.name === "Star Waiver Add");
    assert.ok(target.gain > 8, `expected a big gain, got ${target.gain}`);
    // The top band is 30-45% of what remains.
    assert.equal(target.bidLow, 30);
    assert.equal(target.bidHigh, 45);
    assert.match(target.note, /clear starter upgrade/);
  });

  test("a priority league gets a verdict and no bid", () => {
    const report = waivers(PRIORITY, MY_TEAM, upgrade);
    const target = report.targets.find((t) => t.name === "Star Waiver Add");
    assert.equal(report.system, "priority");
    assert.equal(target.worthPriority, true);
    assert.equal(target.bidLow, null);
    assert.equal(target.bidHigh, null);
  });

  test("the system defaults to FAAB but is always reported", () => {
    // A priority league acting on a bid range finds out at the worst possible
    // moment, so the assumption is stated rather than hidden.
    const report = waivers(NO_KICKER, MY_TEAM, WIRE);
    assert.equal(report.system, "faab");
    assert.equal(report.faab, null);
  });
});

describe("waiver report, degraded inputs", () => {
  test("no player list open says which page is missing", () => {
    const report = waivers(FAAB, MY_TEAM);
    assert.match(report.error, /available-players page/);
  });

  test("no roster open refuses rather than ranking against nothing", () => {
    // The wire alone would produce a list — Yahoo's own ordering, dressed up
    // as advice. There is no bar to clear without the roster.
    const report = waivers(FAAB, WIRE);
    assert.match(report.error, /not your roster/);
  });

  test("no Yahoo tab at all says so specifically", () => {
    const report = buildWaiverReport({ pages: [], tabCount: 0 }, FAAB, { today: NOW });
    assert.match(report.error, /Open your Yahoo My Team page/);
  });

  test("a player already on your roster is never a target", () => {
    // Yahoo's Available filter excludes them, but "All players" does not — and
    // "claim Caleb Williams" reads exactly like real advice.
    const withMine = WIRE.replace("Baker Mayfield", "Caleb Williams");
    const report = waivers(FAAB, MY_TEAM, withMine);
    assert.ok(!report.targets.some((t) => t.name === "Caleb Williams"));
    assert.equal(report.poolSize, 7);
  });

  test("a wire page with no projections is reported, not ranked silently", () => {
    const noProj = "BN Jordan Mason Min - RB\nBN Cam Little Jax - K\n";
    const report = waivers(FAAB, MY_TEAM, noProj);
    // That page reads as a roster, not a wire — which is the honest failure.
    assert.match(report.error, /available-players page/);
  });
});

describe("telling the two pages apart", () => {
  test("the captured pages classify as what they are", () => {
    assert.equal(classifyWeeklyPage(parseWeeklyText(MY_TEAM)), "roster");
    assert.equal(classifyWeeklyPage(parseWeeklyText(WIRE)), "wire");
    assert.equal(
      classifyWeeklyPage(parseWeeklyText(fixture("yahoo_myteam_week5_kicker.txt"))),
      "roster");
  });

  test("a page with neither signal is unknown, not a guess", () => {
    assert.equal(classifyWeeklyPage([{ name: "A" }, { name: "B" }]), "unknown");
    assert.equal(classifyWeeklyPage([]), "unknown");
  });

  test("a whole league's rosters is not one team's roster", () => {
    // The league-rosters page carries slot labels exactly like My Team does,
    // and measuring pickups against a rival's bench prices every claim wrong
    // while still reading plausibly. Size is what separates them.
    const wholeLeague = Array.from({ length: 150 }, (_, i) =>
      ({ name: `Player ${i}`, slot: "BN", rosterStatus: null }));
    assert.equal(classifyWeeklyPage(wholeLeague), "unknown");

    const oneTeam = wholeLeague.slice(0, 16);
    assert.equal(classifyWeeklyPage(oneTeam), "roster");
  });
});

describe("two team pages open", () => {
  // Every team in a league renders the same way at the same /f1/<league>/<id>
  // shape, and nothing in the config records which id is yours. With two open
  // the roster used is whichever tab Chrome listed first — a coin flip that
  // prices every pickup against someone else's bench while reading plausibly.
  const RIVAL = fixture("yahoo_myteam_week5_kicker.txt");

  test("the week report counts the team tabs it did not use", () => {
    const report = buildWeekReport(pagesFrom(MY_TEAM, RIVAL), NO_KICKER, NOW);
    assert.equal(report.otherRosterTabs, 1);
    assert.ok(report.url);
  });

  test("the waiver report counts them too", () => {
    const report = waivers(FAAB, MY_TEAM, RIVAL, WIRE);
    assert.equal(report.otherRosterTabs, 1);
    assert.ok(report.rosterUrl);
  });

  test("one team page is unambiguous and says nothing", () => {
    assert.equal(buildWeekReport(pagesFrom(MY_TEAM), NO_KICKER, NOW).otherRosterTabs, 0);
    assert.equal(waivers(FAAB, MY_TEAM, WIRE).otherRosterTabs, 0);
  });
});
