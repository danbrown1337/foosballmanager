/*
 * A turn that cannot draft its recommendation must not end.
 *
 * This was the single largest cause of missed picks across every measured
 * draft. The last one lost three turns and all three were the same shape —
 * Tee Higgins, Rhamondre Stevenson, Jared Goff — and in each case the panel
 * had already worked out the answer:
 *
 *   Rhamondre Stevenson: name is on the page but he has no row in the
 *     player list — he has been drafted.
 *   Rhamondre Stevenson not found in 3 full passes of the room — marking
 *     drafted and resting him.
 *   Found Rhamondre Stevenson but no Draft button on his row — draft him
 *     manually.
 *
 * Three lines, one second, and the turn was abandoned by the third. The
 * board was stale, the engine asked for a player who left the pool rounds
 * ago, and the room was right to refuse.
 *
 * So the turn now falls through to the queue. Those names come from the same
 * plan, in order, and each was located in this room already in order to be
 * starred — the best-confirmed players available, and a far better fallback
 * than re-searching a shortlist that may hold more ghosts.
 *
 * The other half is timing. A row showed no Draft button at 16:52:06 and the
 * same player was drafted at 16:52:11, so buttons render late and every
 * candidate gets a second look before being written off.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../src/content/overlay.js", import.meta.url), "utf8");
const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

const fallback = /async function draftFromPlan\([\s\S]*?\n  }\n/.exec(src);

test("the no-draft-button branch tries the queue before giving up", () => {
  const branch = /if \(!draftBtn\) \{([\s\S]*?)recordTurnOutcome\("no-draft-button"\)/.exec(src);
  assert.ok(branch, "the no-draft-button branch should still exist");
  const code = stripComments(branch[1]);
  assert.match(code, /await draftFromPlan\(/, "must consult the plan first");
  assert.match(code, /return;/, "a successful fallback must end the turn as a win");
});

test("the fallback pulls from the queue plan, not the shortlist", () => {
  assert.ok(fallback, "draftFromPlan should exist");
  const code = stripComments(fallback[0]);
  assert.match(code, /type:\s*"GET_QUEUE_PLAN"/);
  assert.doesNotMatch(code, /type:\s*"GET_SHORTLIST"/);
});

test("a fallback pick is recorded as mine and as a turn won", () => {
  const code = stripComments(fallback[0]);
  assert.match(code, /IMPORT_PICKS[\s\S]*?by:\s*"mine"/, "the pick must reach the board");
  assert.match(
    code,
    /recordTurnOutcome\("drafted"/,
    "a pick made from the queue is a turn won, not a miss",
  );
});

test("the turn record keeps what the engine asked for", () => {
  /* recordTurnOutcome reads currentRecName for `wanted`, so it has to run
   * before the fallback name replaces it — otherwise wanted and detail agree
   * and the log stops showing how often this path is carrying the draft. */
  const code = stripComments(fallback[0]);
  const record = code.indexOf('recordTurnOutcome("drafted"');
  const reassign = code.indexOf("currentRecName = entry.name");
  assert.ok(record > -1 && reassign > -1);
  assert.ok(
    record < reassign,
    "record the turn before currentRecName moves, or `wanted` loses the original",
  );
});

test("candidates get a second look, because Draft buttons render late", () => {
  const code = stripComments(fallback[0]);
  assert.match(
    code,
    /findDraftButton[\s\S]*?await wait\(\d+\)[\s\S]*?findDraftButton/,
    "one miss on the Draft button is not evidence",
  );
});

test("the fallback is bounded — a turn is on a clock", () => {
  const code = stripComments(fallback[0]);
  assert.match(code, /PLAN_FALLBACK_TRIES/);
  const cap = /const PLAN_FALLBACK_TRIES = (\d+)/.exec(src);
  assert.ok(cap && Number(cap[1]) >= 2 && Number(cap[1]) <= 6,
    `budget should be a few names, not a hunt: got ${cap && cap[1]}`);
});
