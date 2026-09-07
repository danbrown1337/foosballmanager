/*
 * Bye-week stacking. A roster is played weekly: two starters at one position
 * sharing a bye means a week without that position, which ADP — ranking
 * players in isolation — cannot express.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { makePlayer, applyByes } from "../src/engine/board.js";
import { autoPick, byePenalty, surplusPenalty, DEFAULT_BYE_PENALTY, BEYOND_DEPTH_PENALTY } from "../src/engine/autopilot.js";

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

  test("a second tight end is charged even though the flex would take him", () => {
    /* This asserted the opposite until a 15-round mock came back with a
     * second tight end on the bench behind the second-best tight end in the
     * draft, and one every-week running back. A W/R/T flex will accept a
     * tight end and it is nearly always the worst thing to put there: a third
     * back or receiver plays more and scores more in PPR. Being fieldable is
     * not the same as being worth a round. */
    assert.ok(surplusPenalty(te("B", 5), [te("A", 6)], CONFIG) > 0);
  });

  test("a third running back is still free, because he really does start there", () => {
    assert.equal(surplusPenalty(rb("C"), [rb("A"), rb("B")], CONFIG), 0);
  });

  test("but a third is charged, because the flex only holds one", () => {
    // The case that prompted this: a roster that reached three tight ends,
    // each apparently filling the same empty flex slot.
    assert.ok(surplusPenalty(te("C", 5), [te("A", 6), te("B", 5)], CONFIG) > 0);
  });

  test("the flex is shared across positions, not one each", () => {
    // A spare running back has taken the flex, so a second tight end is now
    // a bench player and charged as one.
    const withSpareRb = [rb("A"), rb("B"), rb("C"), te("D", 6)];
    assert.ok(surplusPenalty(te("E", 5), withSpareRb, CONFIG) > 0);
  });

  test("charges more for a backup QB than a third running back", () => {
    // A spare quarterback sits on the bench; a third back starts in the flex.
    const spareQb = surplusPenalty(qb("B"), [qb("A")], CONFIG);
    const thirdRb = surplusPenalty(rb("C"), [rb("A"), rb("B")], CONFIG);
    assert.ok(spareQb > thirdRb, `${spareQb} should exceed ${thirdRb}`);
  });

  test("grows with each additional spare, by a whole bench spot at a time", () => {
    /* Past the depth a roster wants, each further one costs another full
     * bench spot. The assertion used to be that the fourth was double the
     * third, which held while the first spares were charged on a squared
     * curve; with a tight end depth target of zero both are already in the
     * linear region, so the step is what matters, not the ratio. A flat
     * charge was out-ranked twice over, which is what this guards. */
    const second = surplusPenalty(te("B", 5), [te("A", 6)], CONFIG);
    const third = surplusPenalty(te("C", 5), [te("A", 6), te("B", 5)], CONFIG);
    const fourth = surplusPenalty(te("D", 5), [te("A", 6), te("B", 5), te("C", 5)], CONFIG);
    assert.ok(third - second >= BEYOND_DEPTH_PENALTY, `${third} vs ${second}`);
    assert.ok(fourth - third >= BEYOND_DEPTH_PENALTY, `${fourth} vs ${third}`);
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

describe("roster depth", () => {
  const rb = (n) => ({ ...makePlayer({ rank: 1, name: n, team: "DET", pos: "RB", adp: 30 }), bye: 6 });
  const wr = (n) => ({ ...makePlayer({ rank: 1, name: n, team: "CIN", pos: "WR", adp: 30 }), bye: 7 });
  const k = (n) => ({ ...makePlayer({ rank: 1, name: n, team: "SEA", pos: "K", adp: 30 }), bye: 9 });

  test("a second kicker is priced out of the draft entirely", () => {
    // It cannot be played in any week, so it is never worth a roster spot.
    const cost = surplusPenalty(k("B"), [k("A")], CONFIG);
    assert.ok(cost >= 60, `second kicker cost ${cost}`);
  });

  test("bench depth at a weekly position stays affordable", () => {
    // Two starting RBs plus one spare: still wanted, for byes and injuries.
    const mine = [rb("A"), rb("B"), rb("C")];
    assert.ok(surplusPenalty(rb("D"), mine, CONFIG) < 60);
  });

  test("but a sixth receiver is not", () => {
    // A roster that starts two and a flex does not need six, and every extra
    // one is a bench spot not covering a running back's bye.
    const mine = [wr("A"), wr("B"), wr("C"), wr("D"), wr("E")];
    assert.ok(surplusPenalty(wr("F"), mine, CONFIG) >= 60);
  });
});
