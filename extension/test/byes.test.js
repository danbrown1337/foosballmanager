/*
 * Bye-week stacking. A roster is played weekly: two starters at one position
 * sharing a bye means a week without that position, which ADP — ranking
 * players in isolation — cannot express.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { makePlayer, applyByes } from "../src/engine/board.js";
import { byePenalty, DEFAULT_BYE_PENALTY } from "../src/engine/autopilot.js";

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
