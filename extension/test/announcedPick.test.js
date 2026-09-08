/*
 * The room announces every pick as it happens. Captured from a live draft
 * room on 2026-09-07:
 *
 *     Last:
 *     J. DANIELS
 *     (QB · WAS)
 *
 * This is positive evidence — the room saying who went — as against every
 * other source the board has had, which infers a pick from a name leaving a
 * virtualised list. That inference fails whenever the tab is throttled or the
 * rows will not render, and a draft reached round five still recommending
 * A.J. Brown, Drake London, Trey McBride and Derrick Henry, all long gone.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { parseLastPick, findBoardNames, resolveAnnouncedPick } from "../src/lib/textMatch.js";
import { makePlayer } from "../src/engine/board.js";

const LIVE = `John's Pick • You're up in 10 Picks • Round 5, Pick 70
Last:
J. DANIELS
(QB · WAS)
James
DRAFT SCOUT`;

test("reads the announced pick with its position and team", () => {
  assert.deepEqual(parseLastPick(LIVE), {
    label: "J. DANIELS", pos: "QB", team: "WAS",
    block: "Last:\nJ. DANIELS\n(QB · WAS)",
  });
});

test("nothing to announce means nothing announced", () => {
  assert.equal(parseLastPick("Players Board Results Standings"), null);
  assert.equal(parseLastPick("Round 5, Pick 70"), null); // the banner is not a pick
  assert.equal(parseLastPick(""), null);
});

test("the announcement carries what it takes to place an abbreviation", () => {
  /* The whole reason this beats the available list: "B. ROBINSON" is two
   * Atlanta running backs there, and here it comes with a position and a
   * team beside it. */
  const board = [
    makePlayer({ rank: 1, name: "Bijan Robinson", team: "ATL", pos: "RB", adp: 2.3 }),
    makePlayer({ rank: 2, name: "Brian Robinson", team: "WAS", pos: "RB", adp: 152.9 }),
  ];
  const names = new Set(board.map((p) => p.name));
  const announced = parseLastPick("Last:\nB. ROBINSON\n(RB · WAS)");
  const found = findBoardNames(announced.block, names, board);
  assert.deepEqual([...found], ["Brian Robinson"]);
});

test("a genuinely ambiguous announcement resolves to nobody", () => {
  // Same abbreviation, same team, same position: the room cannot separate
  // them either, and a wrong pick recorded is worse than a missed one.
  const board = [
    makePlayer({ rank: 1, name: "Bijan Robinson", team: "ATL", pos: "RB", adp: 2.3 }),
    makePlayer({ rank: 2, name: "Brian Robinson", team: "ATL", pos: "RB", adp: 152.9 }),
  ];
  const names = new Set(board.map((p) => p.name));
  const announced = parseLastPick("Last:\nB. ROBINSON\n(RB · ATL)");
  assert.equal(findBoardNames(announced.block, names, board).size, 0);
});

test("an announcement is one pick however many times it is read", () => {
  // The observer fires on every DOM change and the countdown ticks every
  // second, so the same announcement is read over and over.
  const first = parseLastPick(LIVE);
  const again = parseLastPick(LIVE.replace("10 Picks", "9 Picks"));
  assert.equal(first.block, again.block);
});

test("a defence announcement is read like any other pick", () => {
  /* This required an initial and a surname, which every player has and no
   * defence does. Defences could therefore only be learned from the nickname
   * diff — the fuzziest matching here — and a draft ended with its defence
   * slot empty because the board thought they were all gone. */
  assert.deepEqual(parseLastPick("Last:\nSeahawks\n(DEF · SEA)"), {
    label: "Seahawks", pos: "DEF", team: "SEA",
    block: "Last:\nSeahawks\n(DEF · SEA)",
  });
});

test("and so is a kicker", () => {
  const k = parseLastPick("Last:\nW. LUTZ\n(K · DEN)");
  assert.equal(k.pos, "K");
  assert.equal(k.team, "DEN");
});

test("a defence resolves to the right team's defence", () => {
  const board = [
    makePlayer({ rank: 1, name: "Seattle Defense", team: "SEA", pos: "DEF", adp: 109 }),
    makePlayer({ rank: 2, name: "Denver Defense", team: "DEN", pos: "DEF", adp: 102 }),
  ];
  const names = new Set(board.map((p) => p.name));
  const announced = parseLastPick("Last:\nSeahawks\n(DEF · SEA)");
  assert.deepEqual([...findBoardNames(announced.block, names, board)], ["Seattle Defense"]);
});

/* Particle surnames, which the general matcher cannot key.
 *
 * findBoardNames keys an abbreviation on the last word — "Amon-Ra St. Brown"
 * becomes "a brown" — while the room writes "A. ST. BROWN", whose pattern
 * stops at the dot and gives "a st". They never meet, so a pick the room
 * stated plainly went unrecorded, the board kept offering a player who was
 * gone, and the turn fell through to a reach graded C. */
test("an announcement resolves a name the abbreviation key cannot", () => {
  const board = [
    makePlayer({ rank: 1, name: "Amon-Ra St. Brown", team: "DET", pos: "WR", adp: 7 }),
    makePlayer({ rank: 2, name: "A.J. Brown", team: "NE", pos: "WR", adp: 24 }),
  ];
  assert.equal(resolveAnnouncedPick("A. ST. BROWN", "WR", "DET", board), "Amon-Ra St. Brown");
  // And the team keeps the two Browns apart.
  assert.equal(resolveAnnouncedPick("A. BROWN", "WR", "NE", board), "A.J. Brown");
});

test("it still refuses when two players genuinely fit", () => {
  const board = [
    makePlayer({ rank: 1, name: "Bijan Robinson", team: "ATL", pos: "RB", adp: 2.3 }),
    makePlayer({ rank: 2, name: "Brian Robinson", team: "ATL", pos: "RB", adp: 152.9 }),
  ];
  assert.equal(resolveAnnouncedPick("B. ROBINSON", "RB", "ATL", board), null);
});

test("and nothing at all for a player we don't carry", () => {
  const board = [makePlayer({ rank: 1, name: "Someone Else", team: "KC", pos: "WR", adp: 30 })];
  assert.equal(resolveAnnouncedPick("Z. NOBODY", "WR", "KC", board), null);
  assert.equal(resolveAnnouncedPick("", "WR", "KC", board), null);
});
