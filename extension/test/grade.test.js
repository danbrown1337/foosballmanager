/*
 * The grader, checked against the two rosters this project actually drafted —
 * the one the spec graded B- and a deliberately better one — plus the flags
 * each of them should raise.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { gradeRoster, letterFor } from "../src/engine/grade.js";
import { makePlayer } from "../src/engine/board.js";

const CONFIG = {
  league: { num_teams: 10 },
  roster: { starters: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DEF: 1 }, bench: 6 },
  autopilot: { onesie_min_round: 14 },
};

let seq = 0;
const mk = (name, pos, adp, extra = {}) => ({
  ...makePlayer({ rank: ++seq, name, team: extra.team ?? `T${seq}`, pos, adp,
                  adpSource: extra.adpSource ?? "consensus" }),
  ...extra,
});

/* A board deep enough that position ranks and replacement level mean
 * something: 40 of each skill position, priced by rank. */
function boardWith(mine) {
  const filler = [];
  for (const pos of ["QB", "RB", "WR", "TE", "K", "DEF"]) {
    for (let i = 1; i <= 40; i++) filler.push(mk(`${pos} filler ${i}`, pos, i * 6));
  }
  return [...mine, ...filler];
}

test("letters land on the right side of each boundary", () => {
  assert.equal(letterFor(97), "A+");
  assert.equal(letterFor(93), "A");
  assert.equal(letterFor(83), "B");
  assert.equal(letterFor(73), "C");
  assert.equal(letterFor(59), "F");
});

test("an unfilled starting slot is a zero, not a low score", () => {
  // No waiver pickup rescues a lineup that cannot be fielded.
  const mine = [mk("Only QB", "QB", 40, { draftedBy: "mine" })];
  const report = gradeRoster(boardWith(mine), CONFIG);
  assert.equal(report.grades.RB, "F");
  assert.ok(report.constructionFlags.includes("unfilled_starter_rb"));
});

test("elite starters grade near the top; replacement-level ones grade near C", () => {
  const elite = [
    mk("WR1", "WR", 1, { draftedBy: "mine" }),
    mk("WR2", "WR", 7, { draftedBy: "mine" }),
  ];
  const plain = [
    // Replacement level for WR here is round(10 * (2 + 0.35)) = 24th.
    mk("WR1", "WR", 143, { draftedBy: "mine" }),
    mk("WR2", "WR", 149, { draftedBy: "mine" }),
  ];
  const eliteWr = gradeRoster(boardWith(elite), CONFIG).scores.WR;
  const plainWr = gradeRoster(boardWith(plain), CONFIG).scores.WR;
  assert.ok(eliteWr > 90, `elite WR core scored ${eliteWr}`);
  assert.ok(plainWr > 40 && plainWr < 60, `replacement WR core scored ${plainWr}`);
});

test("the graded mock's construction problems are all flagged", () => {
  /* The 2026-09-07 roster: elite WR/TE, a QB2 and a TE2 behind an elite tight
   * end, and a backfield of other managers' handcuffs. */
  const mine = [
    mk("Jaxon Smith-Njigba", "WR", 7, { draftedBy: "mine" }),
    mk("A.J. Brown", "WR", 24, { draftedBy: "mine" }),
    mk("Trey McBride", "TE", 28, { draftedBy: "mine" }),
    mk("Luther Burden III", "WR", 58, { draftedBy: "mine" }),
    mk("Drake Maye", "QB", 48, { draftedBy: "mine" }),
    mk("Tony Pollard", "RB", 86, { draftedBy: "mine", team: "TEN" }),
    mk("Kyler Murray", "QB", 113, { draftedBy: "mine" }),
    mk("Brenton Strange", "TE", 130, { draftedBy: "mine" }),
    mk("Jason Myers", "K", 122, { draftedBy: "mine" }),
    mk("Kansas City", "DEF", 190, { draftedBy: "mine" }),
    // Three handcuffs, each behind a much better back on his own team.
    mk("Josh Jacobs", "RB", 55, { team: "GB" }),
    mk("MarShawn Lloyd", "RB", 91, { draftedBy: "mine", team: "GB" }),
    mk("Bhayshul Tuten", "RB", 61, { team: "JAX" }),
    mk("Chris Rodriguez Jr.", "RB", 131, { draftedBy: "mine", team: "JAX" }),
    mk("Bijan Robinson", "RB", 2, { team: "ATL" }),
    mk("Brian Robinson Jr.", "RB", 118, { draftedBy: "mine", team: "ATL" }),
  ];
  const log = [
    { round: 1, pos: "WR" }, { round: 2, pos: "WR" }, { round: 3, pos: "TE" },
    { round: 4, pos: "WR" }, { round: 5, pos: "QB" }, { round: 6, pos: "RB" },
    { round: 14, pos: "K" }, { round: 15, pos: "DEF" },
  ];
  const report = gradeRoster(boardWith(mine), CONFIG, log);

  assert.ok(report.constructionFlags.includes("redundant_qb2"),
    `flags were ${report.constructionFlags}`);
  assert.ok(report.constructionFlags.includes("redundant_te2_behind_elite_te"));
  assert.ok(report.constructionFlags.includes("no_rb_until_round_6"));
  assert.ok(report.constructionFlags.some((f) => f.startsWith("backup_heavy")));
  assert.ok(report.strengths.includes("elite_te_advantage"));
  assert.ok(report.strengths.includes("late_k_dst"));
});

test("a clean roster raises none of those flags", () => {
  const mine = [
    mk("QB", "QB", 48, { draftedBy: "mine" }),
    mk("RB1", "RB", 12, { draftedBy: "mine" }),
    mk("RB2", "RB", 30, { draftedBy: "mine" }),
    mk("RB3", "RB", 90, { draftedBy: "mine" }),
    mk("RB4", "RB", 140, { draftedBy: "mine" }),
    mk("WR1", "WR", 7, { draftedBy: "mine" }),
    mk("WR2", "WR", 24, { draftedBy: "mine" }),
    mk("WR3", "WR", 66, { draftedBy: "mine" }),
    mk("TE", "TE", 28, { draftedBy: "mine" }),
    mk("K", "K", 200, { draftedBy: "mine" }),
    mk("DEF", "DEF", 205, { draftedBy: "mine" }),
  ];
  const report = gradeRoster(boardWith(mine), CONFIG,
    [{ round: 2, pos: "RB" }, { round: 14, pos: "K" }, { round: 15, pos: "DEF" }]);
  assert.deepEqual(report.constructionFlags, []);
  assert.ok(report.strengths.includes("rb_depth"));
  assert.ok(["A+", "A", "A-", "B+"].includes(report.grades.overall),
    `overall was ${report.grades.overall} (${report.scores.overall})`);
});
