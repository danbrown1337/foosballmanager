/*
 * Reading the league's shape out of the room instead of taking it on trust.
 *
 * Everything the engine decides derives from these two numbers, and until now
 * both were typed in by hand: a mock room starts a kicker and one flex while
 * the league it is practising for starts no kicker and two, so scoring one as
 * though it were the other is wrong in every rule at once — replacement
 * level, the need gradient, the depth targets, the round kickers unlock, how
 * many picks are left.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { teamsFromRoundChange, parseRosterFormat } from "../src/lib/textMatch.js";

/* The header states slots, not lines, and the W/R/T flex is three lines for
 * one slot — which is exactly what the parser's own cross-check enforces. */
const panel = (...lines) => {
  let slots = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === "W" && lines[i + 1] === "R" && lines[i + 2] === "T") i += 2;
    slots++;
  }
  return [`YOUR TEAM (0/${slots})`, ...lines].join("\n");
};
const bench = (n) => Array(n).fill("BN");

test("the round ticking over states the team count exactly", () => {
  // The last pick of round R is pick R x teams, so the first of round R+1
  // is R x teams + 1. One transition, no estimate.
  assert.equal(teamsFromRoundChange({ round: 1, pick: 12 }, { round: 2, pick: 13 }), 12);
  assert.equal(teamsFromRoundChange({ round: 2, pick: 20 }, { round: 3, pick: 21 }), 10);
  assert.equal(teamsFromRoundChange({ round: 4, pick: 48 }, { round: 5, pick: 49 }), 12);
});

test("a missed round or a number that doesn't divide gives no answer", () => {
  // A skipped poll must produce nothing rather than something wrong.
  assert.equal(teamsFromRoundChange({ round: 1, pick: 9 }, { round: 3, pick: 25 }), null);
  assert.equal(teamsFromRoundChange({ round: 2, pick: 20 }, { round: 3, pick: 22 }), null);
  assert.equal(teamsFromRoundChange(null, { round: 2, pick: 13 }), null);
});

test("a mock room's format is read off its roster panel", () => {
  const format = parseRosterFormat(panel(
    "QB", "WR", "WR", "RB", "RB", "TE", "W", "R", "T", "K", "DEF", ...bench(6)));
  assert.deepEqual(format.starters, { QB: 1, WR: 2, RB: 2, TE: 1, FLEX: 1, K: 1, DEF: 1 });
  assert.equal(format.bench, 6);
  assert.equal(format.total, 15);
});

test("and so is the real league's — no kicker, two flex", () => {
  const format = parseRosterFormat(panel(
    "QB", "WR", "WR", "RB", "RB", "TE", "W", "R", "T", "W", "R", "T", "DEF", ...bench(6)));
  assert.deepEqual(format.starters, { QB: 1, WR: 2, RB: 2, TE: 1, FLEX: 2, DEF: 1 });
  assert.equal(format.starters.K, undefined);
});

test("the flex is three lines, not one, and is counted as one slot", () => {
  // "W" then "R" then "T" down the column is a single W/R/T slot. Counting
  // the labels as a set could never have seen this.
  const one = parseRosterFormat(panel("QB", "RB", "W", "R", "T", ...bench(1)));
  assert.equal(one.starters.FLEX, 1);
  assert.equal(one.starters.WR, undefined);
});

test("a format that doesn't add up to the room's own count is refused", () => {
  // The panel says 15; these labels total 4. Something was misread, and a
  // misread format is worse than none at all.
  const text = ["YOUR TEAM (0/15)", "QB", "RB", "WR", "BN"].join("\n");
  assert.equal(parseRosterFormat(text), null);
});

test("no roster panel means no format", () => {
  assert.equal(parseRosterFormat("Players Board Results Standings"), null);
  assert.equal(parseRosterFormat(""), null);
});
