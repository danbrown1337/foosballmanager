/*
 * Source disagreement, from section 4 of the engine update spec — the
 * MarShawn Lloyd case. Two fresh boards two days apart had him 69th and
 * 117th, while the back ahead of him had a court date brought forward and
 * stayed on the commissioner's exempt list.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { autoPick, dispersionPenalty, DISPERSION_BANDS } from "../src/engine/autopilot.js";
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

test("agreement costs nothing; the bands rise with the gap", () => {
  assert.equal(dispersionPenalty(p("Agreed", "RB", 50, { adpSpread: 6 }), CONFIG), 0);
  assert.equal(dispersionPenalty(p("Slight", "RB", 50, { adpSpread: 15 }), CONFIG),
    DISPERSION_BANDS[2][1]);
  assert.equal(dispersionPenalty(p("Wide", "RB", 50, { adpSpread: 30 }), CONFIG),
    DISPERSION_BANDS[1][1]);
  assert.equal(dispersionPenalty(p("Lloyd", "RB", 93, { adpSpread: 48 }), CONFIG),
    DISPERSION_BANDS[0][1]);
});

test("between two similar backs, the one the sources agree on wins", () => {
  const players = [
    p("Contested Back", "RB", 90, { adpSpread: 48 }),
    p("Settled Back", "RB", 100, { adpSpread: 0 }),
  ];
  assignTiers(players);
  assert.equal(autoPick(players, CONFIG).player.name, "Settled Back");
});

test("but a contested player who is clearly better is still taken", () => {
  // The penalty decides near-ties. It must not blacklist a player because two
  // boards disagree about him — that is how a roster misses a breakout.
  const players = [
    p("Contested Star", "RB", 40, { adpSpread: 48 }),
    p("Settled Journeyman", "RB", 100, { adpSpread: 0 }),
  ];
  assignTiers(players);
  assert.equal(autoPick(players, CONFIG).player.name, "Contested Star");
});
