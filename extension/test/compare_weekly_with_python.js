#!/usr/bin/env node
/*
 * Golden-master test for the weekly parser and engine: replays every case that
 * scripts/weekly_golden.py recorded from Python — page text through
 * browser_sync.parse_weekly_text, rosters through weekly.py — into the ported
 * JS modules, and diffs every field.
 *
 * This is the same evidence standard the draft port is held to. Reading two
 * implementations side by side proves nothing — the draft port has already
 * shown that a translation which looks right can disagree with Python in ways
 * only a diff catches. Here the cases deliberately cover the shapes where a
 * port is most likely to drift: a kicker league, a superflex (where slot fill
 * ORDER changes the answer), an empty slot, an empty roster, doubtful players
 * admitted and excluded, FAAB at two budgets and none, and a wire with an
 * unprojected player on it.
 *
 * Regenerate the fixture whenever weekly.py changes:
 *   python3 scripts/weekly_golden.py > extension/test/weekly_golden.json
 *
 * Run:
 *   node extension/test/compare_weekly_with_python.js
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

import {
  byeOutlook,
  evaluateWaiverTargets,
  lineupChanges,
  optimalLineup,
} from "../src/engine/weekly.js";
import { parseWeeklyText } from "../src/lib/weeklyParse.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const fixturePath = process.argv[2] || join(HERE, "weekly_golden.json");
const golden = JSON.parse(readFileSync(fixturePath, "utf-8"));

let checks = 0;
const fail = (label, what, actual, expected) => {
  console.error(`\nMISMATCH in "${label}" — ${what}`);
  console.error("  python:", JSON.stringify(expected));
  console.error("  js    :", JSON.stringify(actual));
  process.exit(1);
};

function same(label, what, actual, expected) {
  checks += 1;
  try {
    assert.deepEqual(actual, expected);
  } catch {
    fail(label, what, actual, expected);
  }
}

// --- Parsing -----------------------------------------------------------------
//
// Same bytes into both parsers, diff the rows out. The text is embedded in the
// fixture rather than referenced by path, so there is no way for the two sides
// to end up reading different input and quietly agreeing.
for (const testCase of golden.parses) {
  const { label, text, expected } = testCase;
  same(`parse: ${label}`, "rows", parseWeeklyText(text), expected);
}

// --- Lineups -----------------------------------------------------------------
for (const testCase of golden.lineups) {
  const { label, roster, starters, superflex, allowDoubtful, expected } = testCase;
  const best = optimalLineup(roster, starters, { superflex, allowDoubtful });

  same(label, "slot assignment",
    best.starters.map((a) => ({
      slot: a.slot,
      player: a.player ? a.player.name : null,
      emptyReason: a.emptyReason,
    })),
    expected.slots);

  same(label, "bench", best.bench.map((p) => p.name), expected.bench);
  same(label, "projected total",
    Math.round(best.projected * 100) / 100, expected.projected);

  // Warning ORDER is part of the contract: the report prints them in sequence,
  // and a reader scanning for the expensive ones should not have to hunt.
  same(label, "warnings", best.warnings, expected.warnings);

  same(label, "changes",
    lineupChanges(roster, best).map((c) => ({
      slot: c.slot,
      start: c.startPlayer ? c.startPlayer.name : null,
      bench: c.benchPlayer ? c.benchPlayer.name : null,
      gain: c.gain,
      reason: c.reason,
      moveOnly: c.moveOnly,
    })),
    expected.changes);
}

// --- Waivers -----------------------------------------------------------------
for (const testCase of golden.waivers) {
  const { label, roster, available, starters, faabRemaining, top, expected } = testCase;
  const targets = evaluateWaiverTargets(available, roster, starters,
    { faabRemaining, top });

  same(label, "waiver targets",
    targets.map((t) => ({
      name: t.player.name,
      gain: t.gain,
      replaces: t.replaces ? t.replaces.name : null,
      drop: t.drop ? t.drop.name : null,
      rationale: t.rationale,
      bidLow: t.bidLow,
      bidHigh: t.bidHigh,
      worthPriority: t.worthPriority,
      note: t.note,
    })),
    expected);
}

// --- Bye outlook -------------------------------------------------------------
for (const testCase of golden.byes) {
  const { label, roster, week, starters, weeksAhead, byeWeeks, expected } = testCase;
  same(label, "bye outlook",
    byeOutlook(roster, byeWeeks, week, starters, weeksAhead)
      .map(([target, players]) => ({ week: target, players: players.map((p) => p.name) })),
    expected);
}

console.log(`Fixture: ${fixturePath.replace(/.*\/extension\//, "extension/")}`);
console.log(`Compared ${golden.parses.length} parse, ${golden.lineups.length} lineup, `
  + `${golden.waivers.length} waiver and ${golden.byes.length} bye cases `
  + `(${checks} field-level diffs).`);
console.log("PASS: JS weekly parser and engine match Python, field for field.");
