/*
 * The acceptance tests from the second post-implementation review
 * (2026-09-07), run against the engine directly.
 *
 * That review graded a mock whose fifteen picks were made by Yahoo's
 * autodraft, not by this engine: the panel was deadlocked for the whole
 * draft, logging "queue: waiting for the board refresh to finish" once a
 * minute for twenty minutes, because a hidden tab cannot be swept and the
 * queue was gated on a sweep succeeding. So its three failures — QB2, TE2 and
 * K/DST timing — describe Yahoo's behaviour, and its passes do too.
 *
 * These tests exist so that stops being arguable. They put the engine in the
 * exact roster state the review describes and check what it actually does.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { autoPick, defaultOnesieFloor } from "../src/engine/autopilot.js";
import { makePlayer, assignTiers } from "../src/engine/board.js";

const CONFIG = {
  league: { num_teams: 10 },
  roster: { starters: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DEF: 1 }, bench: 6 },
  autopilot: { strategy: "best_player_available", risk_tolerance: "balanced" },
};

let seq = 0;
const p = (name, pos, adp, extra = {}) => ({
  ...makePlayer({ rank: ++seq, name, team: extra.team ?? `T${seq}`, pos, adp,
                  adpSource: "room" }),
  ...extra,
});

// The roster as it stood after ten rounds of that mock.
const AFTER_TEN = [
  ["Jahmyr Gibbs", "RB", 5], ["DeVonta Smith", "WR", 22], ["Jeremiah Love", "RB", 35],
  ["Christian Watson", "WR", 48], ["Lamar Jackson", "QB", 52], ["Tony Pollard", "RB", 86],
  ["Dalton Kincaid", "TE", 78], ["RJ Harvey", "RB", 95], ["Wan'Dale Robinson", "WR", 110],
  ["Tank Bigsby", "RB", 120],
];

function atRound(round, rosterRows, candidates) {
  const mine = rosterRows.map(([n, pos, adp]) => p(n, pos, adp, { draftedBy: "mine" }));
  const filler = Math.max(0, (round - 1) * 10 - mine.length);
  const rivals = Array.from({ length: filler }, (_, i) =>
    p(`Gone${round}_${i}`, "WR", 300 + i, { draftedBy: "rival" }));
  const board = [...mine, ...rivals, ...candidates];
  assignTiers(board);
  return autoPick(board, CONFIG).player.name;
}

test("Test 2 — with a quarterback rostered, a second one loses to a receiver", () => {
  const picked = atRound(11, AFTER_TEN, [
    p("Tyler Shough", "QB", 130),
    p("Comparable Receiver", "WR", 134),
  ]);
  assert.equal(picked, "Comparable Receiver");
});

test("Test 3 — with a tight end rostered, a second one loses to a receiver", () => {
  const picked = atRound(14, [...AFTER_TEN, ["Tyler Shough", "QB", 130],
    ["Seattle Defense", "DEF", 100], ["Brandon Aubrey", "K", 105]], [
    p("Oronde Gadsden", "TE", 150),
    p("Comparable Receiver", "WR", 154),
  ]);
  assert.equal(picked, "Comparable Receiver");
});

test("Test 4 — a defence cannot be taken in round 12, however good it looks", () => {
  /* The strongest form of this: the defence and the kicker are the two best
   * players left by ADP, by eighty places, and the engine still takes neither.
   * They are not scored and beaten — they are not in the pool at all. */
  assert.equal(defaultOnesieFloor(CONFIG), 14);
  const picked = atRound(12, [...AFTER_TEN, ["Tyler Shough", "QB", 130]], [
    p("Seattle Defense", "DEF", 100, { team: "SEA" }),
    p("Brandon Aubrey", "K", 105, { team: "DAL" }),
    p("Bench Receiver", "WR", 180),
  ]);
  assert.equal(picked, "Bench Receiver");
});

test("Test 4b — and they arrive once the floor is reached", () => {
  const picked = atRound(14, [...AFTER_TEN, ["Tyler Shough", "QB", 130]], [
    p("Seattle Defense", "DEF", 100, { team: "SEA" }),
    p("Bench Receiver", "WR", 180),
  ]);
  assert.equal(picked, "Seattle Defense");
});

test("Test 1 — the roster-state gains are not undone by any of the above", () => {
  // Three rounds in with no back at all: the gradient still fires.
  const picked = atRound(4, [
    ["Jaxon Smith-Njigba", "WR", 7], ["A.J. Brown", "WR", 24], ["Trey McBride", "TE", 28],
  ], [
    p("Fourth Receiver", "WR", 46),
    p("Comparable Back", "RB", 50),
  ]);
  assert.equal(picked, "Comparable Back");
});
