/*
 * Bye-week stacking. A roster is played weekly: two starters at one position
 * sharing a bye means a week without that position, which ADP — ranking
 * players in isolation — cannot express.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { makePlayer, applyByes } from "../src/engine/board.js";
import { autoPick, byePenalty, surplusPenalty, DEFAULT_BYE_PENALTY } from "../src/engine/autopilot.js";

const CONFIG = {
  league: { name: "T", num_teams: 12, scoring: "ppr" },
  roster: { starters: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DEF: 1 }, bench: 6, ir: 1 },
  autopilot: { strategy: "best_player_available", risk_tolerance: "balanced", max_bench_per_pos: 3 },
};

const rb = (name, team, bye) => ({ ...makePlayer({ rank: 1, name, team, pos: "RB", adp: 10 }), bye });
const wr = (name, team, bye) => ({ ...makePlayer({ rank: 1, name, team, pos: "WR", adp: 10 }), bye });

describe("byePenalty", () => {
  test("costs nothing when no rostered player at that position shares the bye", () => {
    assert.equal(byePenalty(rb("A", "DET", 6), [rb("B", "KC", 5)], CONFIG), 0);
  });

  test("costs once per clashing player at the same position", () => {
    const mine = [rb("B", "CIN", 6), rb("C", "MIN", 6)];
    assert.equal(byePenalty(rb("A", "DET", 6), mine, CONFIG), 2 * DEFAULT_BYE_PENALTY);
  });

  test("a different position on the same bye doesn't clash", () => {
    // Your RBs and WRs are not competing for the same starting slot.
    assert.equal(byePenalty(rb("A", "DET", 6), [wr("B", "CIN", 6)], CONFIG), 0);
  });

  test("unknown byes are treated as unknown, not as clash-free", () => {
    assert.equal(byePenalty(rb("A", "XXX", null), [rb("B", "CIN", 6)], CONFIG), 0);
  });

  test("can be turned off in config", () => {
    const off = { ...CONFIG, autopilot: { ...CONFIG.autopilot, bye_penalty: 0 } };
    assert.equal(byePenalty(rb("A", "DET", 6), [rb("B", "CIN", 6)], off), 0);
  });
});

describe("applyByes", () => {
  test("attaches the team's bye and leaves unknown teams null", () => {
    const players = [
      makePlayer({ rank: 1, name: "A", team: "DET", pos: "RB", adp: 1 }),
      makePlayer({ rank: 2, name: "B", team: "XXX", pos: "WR", adp: 2 }),
    ];
    applyByes(players, { DET: 6 });
    assert.equal(players[0].bye, 6);
    assert.equal(players[1].bye, null);
  });
});

describe("surplusPenalty", () => {
  const te = (name, bye) => ({ ...makePlayer({ rank: 1, name, team: "KC", pos: "TE", adp: 30 }), bye });
  const rb = (name) => ({ ...makePlayer({ rank: 1, name, team: "DET", pos: "RB", adp: 30 }), bye: 6 });
  const qb = (name) => ({ ...makePlayer({ rank: 1, name, team: "BUF", pos: "QB", adp: 30 }), bye: 7 });

  test("costs nothing while the starting slots are still empty", () => {
    assert.equal(surplusPenalty(te("A", 5), [], CONFIG), 0);
  });

  test("charges for a second tight end when the league starts one", () => {
    // The case that prompted this: three tight ends offered to a roster
    // already holding one.
    assert.ok(surplusPenalty(te("B", 5), [te("A", 6)], CONFIG) > 0);
  });

  test("charges more for a backup QB than a third running back", () => {
    // A spare quarterback sits on the bench; a third back starts in the flex.
    const spareQb = surplusPenalty(qb("B"), [qb("A")], CONFIG);
    const thirdRb = surplusPenalty(rb("C"), [rb("A"), rb("B")], CONFIG);
    assert.ok(spareQb > thirdRb, `${spareQb} should exceed ${thirdRb}`);
  });

  test("grows with each additional spare", () => {
    const first = surplusPenalty(te("B", 5), [te("A", 6)], CONFIG);
    const second = surplusPenalty(te("C", 5), [te("A", 6), te("B", 5)], CONFIG);
    assert.ok(second > first);
  });
});

describe("unavailable players", () => {
  test("a player out for the season is not draftable at all", () => {
    // Drafting one spends a roster spot on nobody. MarShawn Lloyd was queued
    // on PUP-R in a live mock, because nothing here knew what that meant.
    const players = [
      { ...makePlayer({ rank: 1, name: "Out Guy", team: "GB", pos: "RB", adp: 1 }), status: "PUP-R" },
      { ...makePlayer({ rank: 2, name: "Fit Guy", team: "DET", pos: "RB", adp: 40 }), status: null },
    ];
    assert.equal(autoPick(players, CONFIG).player.name, "Fit Guy");
  });

  test("a Not Active player is not draftable either", () => {
    // Yahoo's NA tag. Two were queued before this existed.
    const players = [
      { ...makePlayer({ rank: 1, name: "Not Active", team: "FA", pos: "WR", adp: 1 }), status: "NA" },
      { ...makePlayer({ rank: 2, name: "Fit Guy", team: "DET", pos: "WR", adp: 40 }), status: null },
    ];
    assert.equal(autoPick(players, CONFIG).player.name, "Fit Guy");
  });

  test("week-to-week designations are left alone", () => {
    // Questionable is a lineup decision, not a lost season.
    const players = [
      { ...makePlayer({ rank: 1, name: "Iffy Guy", team: "GB", pos: "RB", adp: 1 }), status: "Q" },
      { ...makePlayer({ rank: 2, name: "Fit Guy", team: "DET", pos: "RB", adp: 40 }), status: null },
    ];
    assert.equal(autoPick(players, CONFIG).player.name, "Iffy Guy");
  });
});
