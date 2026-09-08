/*
 * Two players the draft room writes identically.
 *
 * The room shows an initial, a surname, a position and a team — "B. ROBINSON
 * RB Atl". Bijan and Brian Robinson match on all four, confirmed against
 * Sleeper's roster as well as our own file, so nothing on the page tells them
 * apart. Four drafts took the wrong one. The worse player now stops being
 * draftable rather than the matcher getting a fifth heuristic.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { autoPick, isDraftable } from "../src/engine/autopilot.js";
import { makePlayer, assignTiers } from "../src/engine/board.js";

const CONFIG = {
  league: { num_teams: 10 },
  roster: { starters: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DEF: 1 }, bench: 6 },
  autopilot: { strategy: "best_player_available", risk_tolerance: "balanced" },
};

let seq = 0;
const p = (name, pos, team, adp, extra = {}) => ({
  ...makePlayer({ rank: ++seq, name, team, pos, adp, adpSource: "consensus" }),
  ...extra,
});

test("the worse namesake is never offered", () => {
  const players = [
    p("Bijan Robinson", "RB", "ATL", 2.3, { draftedBy: "rival" }), // gone in round 1
    p("Brian Robinson", "RB", "ATL", 152.9, { ambiguous: true }),
    p("Ordinary Back", "RB", "DEN", 160),
  ];
  assignTiers(players);
  // With Bijan gone, Brian is the best remaining by ADP by a distance — and
  // is exactly the pick that keeps happening by mistake.
  assert.equal(autoPick(players, CONFIG).player.name, "Ordinary Back");
});

test("the better one is unaffected", () => {
  const players = [
    p("Bijan Robinson", "RB", "ATL", 2.3),
    p("Brian Robinson", "RB", "ATL", 152.9, { ambiguous: true }),
  ];
  assignTiers(players);
  assert.equal(autoPick(players, CONFIG).player.name, "Bijan Robinson");
});

test("he stays on the board so a rival taking him is still recognised", () => {
  // Removing him outright would make his pick unattributable, and an
  // unattributed pick leaves the board believing he is still available.
  const players = [
    p("Bijan Robinson", "RB", "ATL", 2.3),
    p("Brian Robinson", "RB", "ATL", 152.9, { ambiguous: true }),
  ];
  assert.ok(players.some((x) => x.name === "Brian Robinson"),
    "the ambiguous player must remain part of the board");
});

/* Every path that can put a player in front of you, not just autoPick.
 *
 * The queue's endgame reservation checked only that a player was undrafted
 * and played the right position, so it could reserve someone on injured
 * reserve, someone no room drafts at all, or the worse of two players written
 * identically — and Yahoo drafts whatever is reserved the moment the panel
 * misses a turn. One predicate now, shared. */
test("the shared test refuses everyone the engine refuses", () => {
  const ok = p("Fine Player", "RB", "DEN", 40);
  assert.equal(isDraftable(ok), true);

  assert.equal(isDraftable({ ...ok, draftedBy: "rival" }), false);
  assert.equal(isDraftable({ ...ok, status: "IR-R" }), false);
  assert.equal(isDraftable({ ...ok, status: "CEL" }), false);
  assert.equal(isDraftable({ ...ok, undrafted: true }), false);
  assert.equal(isDraftable({ ...ok, ambiguous: true }), false);
});

test("and it is what autoPick uses, so the two cannot drift", () => {
  const players = [
    p("Injured Back", "RB", "CAR", 30, { status: "IR-R" }),
    p("Wrong Robinson", "RB", "ATL", 152.9, { ambiguous: true }),
    p("Unlisted Receiver", "WR", "DAL", 113, { undrafted: true }),
    p("Ordinary Back", "RB", "DEN", 160),
  ];
  assignTiers(players);
  assert.equal(autoPick(players, CONFIG).player.name, "Ordinary Back");
});
