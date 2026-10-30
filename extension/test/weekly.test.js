/*
 * Unit tests for the ported weekly engine.
 *
 * compare_weekly_with_python.js is the primary evidence that this port is
 * correct — it diffs real engine output field for field against Python. These
 * cover what a fixture can't:
 *   - the season calendar, which depends on "today" and so can't be frozen
 *     into a fixture generated at some other time;
 *   - pyRound, the tie-break that made the two languages disagree;
 *   - a handful of shapes worth failing loudly and locally rather than as one
 *     line of a large diff.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  byeOutlook,
  canonicalSlot,
  currentWeek,
  expandSlots,
  isPlayable,
  isStartable,
  optimalLineup,
  pyRound,
  slotAccepts,
  waiverSystem,
  weekLabel,
} from "../src/engine/weekly.js";

const player = (name, pos, proj = null, extra = {}) => ({
  name, pos, team: "FA", slot: null, status: "", opponent: null,
  proj, bye: false, byeWeek: null, ...extra,
});

describe("pyRound", () => {
  test("rounds a half to even, the way Python does", () => {
    // Math.round would give 13, 3 and 1 here. At a $50 budget that is the
    // difference between "bid 12" and "bid 13" against the same Python report.
    assert.equal(pyRound(12.5), 12);
    assert.equal(pyRound(2.5), 2);
    assert.equal(pyRound(0.5), 0);
    assert.equal(pyRound(7.5), 8);
    assert.equal(pyRound(3.5), 4);
  });

  test("leaves non-ties alone", () => {
    assert.equal(pyRound(12.4), 12);
    assert.equal(pyRound(12.6), 13);
  });

  test("handles negatives like Python", () => {
    assert.equal(pyRound(-2.5), -2);
    assert.equal(pyRound(-3.5), -4);
  });

  test("rounds to a given number of digits", () => {
    assert.equal(pyRound(6.699999999999999, 2), 6.7);
    assert.equal(pyRound(-2.4000000000000004, 2), -2.4);
  });
});

describe("slots", () => {
  test("counts become repeats and absent positions stay absent", () => {
    assert.deepEqual(expandSlots({ QB: 1, RB: 2 }), ["QB", "RB", "RB"]);
    assert.ok(!expandSlots({ QB: 1, RB: 2 }).includes("K"));
    assert.deepEqual(expandSlots({ QB: 1, K: 0 }), ["QB"]);
  });

  test("the narrower flex is filled before a wider one", () => {
    // Load-bearing: fill the superflex first and it takes the only running
    // back, stranding the W/R/T beside a quarterback it cannot use.
    const slots = expandSlots({ SUPERFLEX: 1, FLEX: 1 });
    assert.ok(slots.indexOf("FLEX") < slots.indexOf("SUPERFLEX"));
  });

  test("mixed flex does not strand a slot", () => {
    const roster = [player("RB3", "RB", 20), player("QB2", "QB", 18)];
    // Written superflex-first on purpose: config order must not decide this.
    const best = optimalLineup(roster, { SUPERFLEX: 1, FLEX: 1 });
    assert.equal(best.projected, 38);
  });

  test("flex takes RB/WR/TE but never a QB or a defence", () => {
    assert.ok(slotAccepts("FLEX", "RB") && slotAccepts("W/R/T", "TE"));
    assert.ok(!slotAccepts("FLEX", "QB"));
    assert.ok(!slotAccepts("FLEX", "DEF"));
  });

  test("W/R/T and FLEX are the same slot, so moving between them is not a move", () => {
    assert.equal(canonicalSlot("W/R/T"), canonicalSlot("FLEX"));
    assert.equal(canonicalSlot("SUPERFLEX"), "SUPERFLEX");
  });
});

describe("startability", () => {
  for (const status of ["O", "IR", "SUSP", "PUP", "NA"]) {
    test(`${status} can never be started`, () => {
      assert.ok(!isPlayable(player("X", "RB", 12, { status })));
    });
  }

  test("a bye is never playable regardless of projection", () => {
    assert.ok(!isPlayable(player("X", "RB", 12, { bye: true })));
  });

  test("doubtful is playable but not startable by default", () => {
    const p = player("X", "RB", 12, { status: "D" });
    assert.ok(isPlayable(p) && !isStartable(p));
  });

  test("an unprojected player is not treated as projected zero", () => {
    const best = optimalLineup(
      [player("Known", "RB", 8), player("Unknown", "RB", null)], { RB: 1 });
    assert.deepEqual([...best.starters].map((a) => a.player.name), ["Known"]);
  });

  test("an empty slot is reported rather than hidden", () => {
    const best = optimalLineup([player("QB1", "QB", 20)], { QB: 1, DEF: 1 });
    const empty = best.starters.filter((a) => !a.player);
    assert.equal(empty.length, 1);
    assert.equal(empty[0].slot, "DEF");
    assert.ok(empty[0].emptyReason);
  });
});

describe("season calendar", () => {
  const config = { season: { week1_start: "2026-09-10" } };

  test("derives the week from kickoff", () => {
    assert.equal(currentWeek(config, new Date("2026-09-10T12:00:00Z")), 1);
    assert.equal(currentWeek(config, new Date("2026-09-16T12:00:00Z")), 1);
    assert.equal(currentWeek(config, new Date("2026-09-17T12:00:00Z")), 2);
    assert.equal(currentWeek(config, new Date("2026-10-01T12:00:00Z")), 4);
  });

  test("returns null before kickoff and caps at 18", () => {
    assert.equal(currentWeek(config, new Date("2026-08-01T12:00:00Z")), null);
    assert.equal(currentWeek(config, new Date("2027-06-01T12:00:00Z")), 18);
  });

  test("refuses to guess a week that isn't configured", () => {
    assert.equal(currentWeek({}, new Date("2026-10-01T12:00:00Z")), null);
    assert.equal(currentWeek({ season: { week1_start: "nonsense" } }), null);
  });

  test("preseason and unconfigured read differently", () => {
    // One is a date to wait for, the other a line of YAML to fill in.
    assert.match(weekLabel(config, new Date("2026-09-01T12:00:00Z")), /Preseason/);
    assert.equal(weekLabel({}, new Date("2026-10-01T12:00:00Z")), "Week unknown");
  });
});

describe("waiver system config", () => {
  test("defaults to FAAB and falls back from remaining to budget", () => {
    assert.deepEqual(waiverSystem({}), ["faab", null]);
    assert.deepEqual(waiverSystem({ waivers: { faab_budget: 200 } }), ["faab", 200]);
    assert.deepEqual(
      waiverSystem({ waivers: { faab_budget: 200, faab_remaining: 37 } }),
      ["faab", 37]);
  });

  test("reads priority, and treats an unknown system as FAAB", () => {
    assert.equal(waiverSystem({ waivers: { system: "priority" } })[0], "priority");
    assert.equal(waiverSystem({ waivers: { system: "auction-ish" } })[0], "faab");
  });
});

describe("bye outlook", () => {
  test("prefers the page's bye week over the shipped table", () => {
    const roster = [player("QB1", "QB", 20, { team: "KC", byeWeek: 6 })];
    const out = byeOutlook(roster, { KC: 99 }, 5, { QB: 1 }, 3);
    assert.deepEqual(out.map(([w]) => w), [6]);
  });

  test("falls back to the table when the page didn't say", () => {
    const roster = [player("QB1", "QB", 20, { team: "KC" })];
    assert.deepEqual(byeOutlook(roster, { KC: 6 }, 5, { QB: 1 }, 3).map(([w]) => w), [6]);
  });

  test("stays quiet when depth covers the bye", () => {
    const roster = [
      player("RB1", "RB", 10, { team: "DET", byeWeek: 6 }),
      player("RB2", "RB", 9, { team: "KC", byeWeek: 9 }),
      player("RB3", "RB", 8, { team: "SF", byeWeek: 11 }),
    ];
    assert.deepEqual(byeOutlook(roster, {}, 5, { RB: 2 }, 3), []);
  });

  test("returns nothing without a known week", () => {
    const roster = [player("QB1", "QB", 20, { team: "KC", byeWeek: 6 })];
    assert.deepEqual(byeOutlook(roster, {}, null, { QB: 1 }, 3), []);
  });
});
