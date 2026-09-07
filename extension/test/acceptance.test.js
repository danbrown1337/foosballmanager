/*
 * The acceptance tests from the 2026-09-07 engine update spec, section 24,
 * written against the real engine. Each one names the behaviour the spec asks
 * for rather than the numbers that currently produce it, so a later change of
 * weights has to keep the behaviour or fail here.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  autoPick, needBonus, openFlexSlots, defaultOnesieFloor,
} from "../src/engine/autopilot.js";
import { makePlayer, assignTiers } from "../src/engine/board.js";

const CONFIG = {
  league: { num_teams: 10 },
  roster: { starters: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DEF: 1 }, bench: 6 },
  autopilot: { strategy: "best_player_available", risk_tolerance: "balanced" },
};

let seq = 0;
const p = (name, pos, adp, extra = {}) => ({
  ...makePlayer({ rank: ++seq, name, team: extra.team ?? `T${seq}`, pos, adp,
                  adpSource: "consensus" }),
  ...extra,
});

// picksMade is derived from how many players are drafted, so fill the board
// with rivals' picks to place the engine at a given round.
function atRound(round, mine, board) {
  const already = (round - 1) * CONFIG.league.num_teams - mine.length;
  const rivals = Array.from({ length: Math.max(0, already) }, (_, i) =>
    p(`Rival${i}`, "WR", 300 + i, { draftedBy: "rival" }));
  const players = [...mine, ...rivals, ...board];
  assignTiers(players);
  return players;
}

test("A — an elite opening is still reachable, with no forced early back", () => {
  const players = atRound(1, [], [
    p("Elite Receiver", "WR", 5),
    p("Ordinary Back", "RB", 20),
  ]);
  assert.equal(autoPick(players, CONFIG).player.name, "Elite Receiver");
});

test("B — entering round 4 with no backs, a comparable back gains priority", () => {
  const mine = [
    p("My WR1", "WR", 7, { draftedBy: "mine" }),
    p("My WR2", "WR", 24, { draftedBy: "mine" }),
    p("My TE", "TE", 28, { draftedBy: "mine" }),
  ];
  const players = atRound(4, mine, [
    p("Fourth Receiver", "WR", 46),
    p("Comparable Back", "RB", 50),
  ]);
  assert.equal(autoPick(players, CONFIG).player.name, "Comparable Back");
});

test("B — and by round 5 a comparable back beats the quarterback", () => {
  const mine = [
    p("My WR1", "WR", 7, { draftedBy: "mine" }),
    p("My WR2", "WR", 24, { draftedBy: "mine" }),
    p("My TE", "TE", 28, { draftedBy: "mine" }),
    p("My WR3", "WR", 44, { draftedBy: "mine" }),
  ];
  const players = atRound(5, mine, [
    p("The Quarterback", "QB", 47),
    p("Comparable Back", "RB", 50),
  ]);
  assert.equal(autoPick(players, CONFIG).player.name, "Comparable Back");
});

test("B — but a genuinely elite player elsewhere still wins", () => {
  // The gradient is capped at one clear tier on purpose: it must not turn
  // into "take a back by round 5" regardless of what is on the board.
  const mine = [
    p("My WR1", "WR", 7, { draftedBy: "mine" }),
    p("My WR2", "WR", 24, { draftedBy: "mine" }),
    p("My TE", "TE", 28, { draftedBy: "mine" }),
    p("My WR3", "WR", 44, { draftedBy: "mine" }),
  ];
  const players = atRound(5, mine, [
    p("Fallen Star", "WR", 9),
    p("Ordinary Back", "RB", 95),
  ]);
  assert.equal(autoPick(players, CONFIG).player.name, "Fallen Star");
});

test("C — a second quarterback is passed over for a comparable back", () => {
  const mine = [
    p("My QB", "QB", 47, { draftedBy: "mine" }),
    p("My RB1", "RB", 20, { draftedBy: "mine" }),
    p("My RB2", "RB", 35, { draftedBy: "mine" }),
    p("My WR1", "WR", 7, { draftedBy: "mine" }),
    p("My WR2", "WR", 24, { draftedBy: "mine" }),
    p("My TE", "TE", 28, { draftedBy: "mine" }),
  ];
  const players = atRound(10, mine, [
    p("Second Quarterback", "QB", 113),
    p("Bench Back", "RB", 125),
  ]);
  assert.equal(autoPick(players, CONFIG).player.name, "Bench Back");
});

test("D — a second tight end is passed over for a comparable receiver", () => {
  const mine = [
    p("My QB", "QB", 47, { draftedBy: "mine" }),
    p("My RB1", "RB", 20, { draftedBy: "mine" }),
    p("My RB2", "RB", 35, { draftedBy: "mine" }),
    p("My WR1", "WR", 7, { draftedBy: "mine" }),
    p("My WR2", "WR", 24, { draftedBy: "mine" }),
    p("My WR3", "WR", 60, { draftedBy: "mine" }),
    p("Elite TE", "TE", 28, { draftedBy: "mine" }),
  ];
  const players = atRound(12, mine, [
    p("Second Tight End", "TE", 129),
    p("Bench Receiver", "WR", 140),
  ]);
  assert.equal(autoPick(players, CONFIG).player.name, "Bench Receiver");
});

test("E — no kicker or defence before the last rounds of the roster", () => {
  const mine = [
    p("My QB", "QB", 47, { draftedBy: "mine" }),
    p("My RB1", "RB", 20, { draftedBy: "mine" }),
    p("My RB2", "RB", 35, { draftedBy: "mine" }),
    p("My WR1", "WR", 7, { draftedBy: "mine" }),
    p("My WR2", "WR", 24, { draftedBy: "mine" }),
    p("My TE", "TE", 28, { draftedBy: "mine" }),
    p("My FLEX", "WR", 60, { draftedBy: "mine" }),
  ];
  for (const round of [8, 10, 12]) {
    const players = atRound(round, mine, [
      p("Cheap Kicker", "K", 80),
      p("Bench Back", "RB", 150),
    ]);
    assert.equal(autoPick(players, CONFIG).player.name, "Bench Back",
      `round ${round} should not take a kicker`);
  }
});

test("E — and the kicker does arrive at the end", () => {
  const mine = [
    p("My QB", "QB", 47, { draftedBy: "mine" }),
    p("My RB1", "RB", 20, { draftedBy: "mine" }),
    p("My RB2", "RB", 35, { draftedBy: "mine" }),
    p("My WR1", "WR", 7, { draftedBy: "mine" }),
    p("My WR2", "WR", 24, { draftedBy: "mine" }),
    p("My TE", "TE", 28, { draftedBy: "mine" }),
    p("My FLEX", "WR", 60, { draftedBy: "mine" }),
  ];
  const players = atRound(14, mine, [
    p("Cheap Kicker", "K", 80),
    p("Bench Back", "RB", 150),
  ]);
  assert.equal(autoPick(players, CONFIG).player.name, "Cheap Kicker");
});

/* The league this is actually for: no kicker at all, and two W/R/T flex
 * slots instead of the usual one. Both are the kind of shape that a rule
 * written for the common case gets quietly wrong. */
const NO_KICKER_TWO_FLEX = {
  league: { num_teams: 10 },
  roster: { starters: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 2, DEF: 1 }, bench: 6 },
  autopilot: { strategy: "best_player_available", risk_tolerance: "balanced" },
};

test("two flex slots keep the need gradient alive past the second back", () => {
  // Two backs and two receivers fills RB and WR, and leaves two starting
  // slots empty. The gradient used to stop dead here.
  const mine = [
    p("My RB1", "RB", 12, { draftedBy: "mine" }),
    p("My RB2", "RB", 30, { draftedBy: "mine" }),
    p("My WR1", "WR", 7, { draftedBy: "mine" }),
    p("My WR2", "WR", 24, { draftedBy: "mine" }),
  ];
  assert.equal(openFlexSlots(mine, NO_KICKER_TWO_FLEX), 2);
  const bonus = needBonus(p("Third Back", "RB", 60), mine, NO_KICKER_TWO_FLEX, 40);
  assert.ok(bonus < 0, `a third back should still be pulled forward, got ${bonus}`);
});

test("and a one-flex league is unaffected by that", () => {
  const oneFlex = {
    ...NO_KICKER_TWO_FLEX,
    roster: { ...NO_KICKER_TWO_FLEX.roster,
              starters: { ...NO_KICKER_TWO_FLEX.roster.starters, FLEX: 1 } },
  };
  const mine = [
    p("My RB1", "RB", 12, { draftedBy: "mine" }),
    p("My RB2", "RB", 30, { draftedBy: "mine" }),
    p("My WR1", "WR", 7, { draftedBy: "mine" }),
    p("My WR2", "WR", 24, { draftedBy: "mine" }),
    p("My FLEX", "WR", 50, { draftedBy: "mine" }),
  ];
  assert.equal(openFlexSlots(mine, oneFlex), 0);
  assert.equal(needBonus(p("Third Back", "RB", 60), mine, oneFlex, 40), 0);
});

test("with only a defence to fill, it waits for the final round", () => {
  // Two onesies want the last two rounds; one wants the last one. A league
  // with no kicker should not give up a round of bench upside to a defence
  // that would have cost the same a round later.
  assert.equal(defaultOnesieFloor(NO_KICKER_TWO_FLEX), 15);
  const withKicker = {
    ...NO_KICKER_TWO_FLEX,
    roster: { ...NO_KICKER_TWO_FLEX.roster,
              starters: { ...NO_KICKER_TWO_FLEX.roster.starters, K: 1 }, bench: 5 },
  };
  assert.equal(defaultOnesieFloor(withKicker), 14);
});

test("a league that starts neither never drafts one", () => {
  const noOnesies = {
    ...NO_KICKER_TWO_FLEX,
    roster: { starters: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 2 }, bench: 6 },
  };
  assert.equal(defaultOnesieFloor(noOnesies), Infinity);
});
