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
import { parseLastPick, findBoardNames } from "../src/lib/textMatch.js";
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
