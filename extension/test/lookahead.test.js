/*
 * Tier cliffs and expected availability — sections 16 and 17 of the engine
 * update spec. The spec assumed a projections API for the first and an ADP
 * standard deviation for the second; the draft room publishes projected
 * points on every row, and the panel already knows how many picks away the
 * next turn is, so both are measurable from what we have.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  autoPick, tierCliffBonus, urgencyBonus, CLIFF_CAP, URGENCY_BONUS, PATIENCE_PENALTY,
} from "../src/engine/autopilot.js";
import { makePlayer, assignTiers } from "../src/engine/board.js";

const CONFIG = {
  league: { num_teams: 10 },
  roster: { starters: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DEF: 1 }, bench: 6 },
  autopilot: { strategy: "best_player_available", risk_tolerance: "balanced" },
};

let seq = 0;
const p = (name, pos, adp, extra = {}) => ({
  ...makePlayer({ rank: ++seq, name, team: `T${seq}`, pos, adp, adpSource: "room" }),
  ...extra,
});

test("no projections means no cliff, rather than a guessed one", () => {
  const players = [p("A", "RB", 50), p("B", "RB", 55)];
  assert.equal(tierCliffBonus(players[0], players, CONFIG), 0);
});

test("the last player above a drop is pulled forward", () => {
  const players = [
    p("Last Of His Tier", "RB", 50, { proj: 220 }),
    p("First Of The Next", "RB", 55, { proj: 150 }),
  ];
  const bonus = tierCliffBonus(players[0], players, CONFIG);
  assert.ok(bonus < 0, "a cliff should pull him forward");
  assert.equal(bonus, -CLIFF_CAP, "and a 70-point drop is capped");
});

test("no drop means nothing is lost by waiting", () => {
  const players = [
    p("One Of Many", "WR", 50, { proj: 180 }),
    p("Just As Good", "WR", 55, { proj: 182 }),
  ];
  assert.equal(tierCliffBonus(players[0], players, CONFIG), 0);
});

test("without turn context, availability says nothing", () => {
  const players = [p("A", "RB", 50), p("B", "RB", 55)];
  assert.equal(urgencyBonus(players[0], players, CONFIG, 20), 0);
});

test("a position whose next man also goes is urgent; one that keeps can wait", () => {
  const withTurn = { ...CONFIG, autopilot: { ...CONFIG.autopilot, picks_until_turn: 10 } };
  // Pick 21 next; the window closes at 31.
  const runOnPosition = [p("Back Now", "RB", 22), p("Back Soon", "RB", 28)];
  const deepPosition = [p("Receiver Now", "WR", 22), p("Receiver Later", "WR", 90)];
  assert.equal(urgencyBonus(runOnPosition[0], runOnPosition, withTurn, 20), -URGENCY_BONUS);
  assert.equal(urgencyBonus(deepPosition[0], deepPosition, withTurn, 20), PATIENCE_PENALTY);
});

test("between two equal players, take the one whose position won't keep", () => {
  const withTurn = { ...CONFIG, autopilot: { ...CONFIG.autopilot, picks_until_turn: 10 } };
  const players = [
    p("Scarce Back", "RB", 24),
    p("Scarce Back 2", "RB", 30),
    p("Deep Receiver", "WR", 24),
    p("Deep Receiver 2", "WR", 120),
  ];
  const rivals = Array.from({ length: 20 }, (_, i) =>
    p(`Gone${i}`, "TE", 200 + i, { draftedBy: "rival" }));
  const board = [...players, ...rivals];
  assignTiers(board);
  assert.equal(autoPick(board, withTurn).player.name, "Scarce Back");
});
