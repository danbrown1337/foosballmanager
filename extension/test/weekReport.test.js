/*
 * The weekly panel end to end, minus Chrome.
 *
 * background.js's weekReport() is the seam between three things that are each
 * tested on their own — the content script's page text, weeklyParse.js, and
 * weekly.js — and a seam is exactly where a port stops being covered by its
 * parts. Rather than import background.js (which needs the chrome.* globals),
 * this reproduces the same composition over the captured page and asserts on
 * the report shape the popup actually renders, field by field.
 *
 * If weekReport() and this test drift apart the panel breaks silently, so the
 * shape assertions below name every field popup.js reads.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { parseWeeklyText } from "../src/lib/weeklyParse.js";
import { lineupChanges, optimalLineup, weekLabel } from "../src/engine/weekly.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = (name) =>
  readFileSync(join(HERE, "..", "..", "tests", "fixtures", name), "utf-8");

/** The same composition weekReport() performs, over page text. */
function buildReport(pageText, config) {
  const roster = parseWeeklyText(pageText);
  const starters = config?.roster?.starters || {};
  const superflex = !!config?.league?.superflex;
  const best = optimalLineup(roster, starters, { superflex });
  return {
    label: weekLabel(config, new Date("2026-09-24T12:00:00Z")),
    starters: best.starters.map((a) => ({
      slot: a.slot,
      name: a.player ? a.player.name : null,
      pos: a.player ? a.player.pos : null,
      opponent: a.player ? a.player.opponent : null,
      status: a.player ? (a.player.bye ? "BYE" : a.player.status) : "",
      proj: a.player ? a.player.proj : null,
      emptyReason: a.emptyReason,
    })),
    bench: best.bench.map((p) => ({ name: p.name, status: p.bye ? "BYE" : p.status })),
    projected: Math.round(best.projected * 100) / 100,
    warnings: best.warnings,
    changes: lineupChanges(roster, best).map((c) => ({
      slot: c.slot,
      start: c.startPlayer ? c.startPlayer.name : null,
      bench: c.benchPlayer ? c.benchPlayer.name : null,
      reason: c.reason,
      moveOnly: c.moveOnly,
    })),
    hasProjections: roster.some((p) => p.proj !== null && p.proj !== undefined),
  };
}

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
  test("a page with no roster on it yields no starters, not a crash", () => {
    const report = buildReport("Yahoo Sports\nSign in\n", NO_KICKER);
    assert.ok(report.starters.every((s) => s.name === null));
    assert.equal(report.hasProjections, false);
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
