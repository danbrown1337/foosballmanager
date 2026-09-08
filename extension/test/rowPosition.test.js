/*
 * A row that states a different position is a different player.
 *
 * findPlayerClickTarget confirms an abbreviated match against the row's team,
 * because "B. Robinson" names two Atlanta running backs. The full-name path
 * confirmed nothing: a name matched exactly was accepted wherever it appeared.
 *
 * That holds until two players genuinely share a name. The board's Mike Evans
 * is a receiver in San Francisco; a roster panel came back reading "M. Evans
 * TE Car". Same shape as the Robinson bug, reachable without an abbreviation
 * being involved at all.
 *
 * Position is the discriminator to use. Team codes differ between sources —
 * LAR, LA, Rams — so a team mismatch is often our data, not theirs. "WR" is
 * "WR" everywhere.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { rowPosition } from "../src/lib/domActions.js";

/* Enough of an element for rowPosition: it reads cells and their text. */
const row = (...cells) => ({
  querySelectorAll: () => cells.map((textContent) => ({ textContent })),
});

test("a row that names one position reports it", () => {
  assert.equal(rowPosition(row("M. Evans", "WR", "SF", "Bye 8", "70.9")), "WR");
  assert.equal(rowPosition(row("M. Evans", "TE", "Car", "Bye 5", "128")), "TE");
});

test("defences and kickers are read too", () => {
  assert.equal(rowPosition(row("Seahawks", "DEF", "Bye 11")), "DEF");
  assert.equal(rowPosition(row("H. Butker", "K", "KC", "Bye 10")), "K");
});

test("a row stating nothing gets no opinion", () => {
  assert.equal(rowPosition(row("M. Evans", "Bye 8", "70.9")), null);
  assert.equal(rowPosition(row()), null);
  assert.equal(rowPosition(null), null);
});

test("a row stating two positions gets no opinion rather than a guess", () => {
  /* The roster panel writes flex slots as separate cells — "W R T" — and a
   * confused row must not be allowed to veto a pick. */
  assert.equal(rowPosition(row("W", "R", "T", "RB", "WR")), null);
});

test("whitespace and case are not a disagreement", () => {
  assert.equal(rowPosition(row("M. Evans", "  wr  ", "SF")), "WR");
});

/* The wiring: the filter has to run before the ADP arbitration, for the same
 * reason the Yahoo id does — ADP is a proxy that gives up when two rows are
 * close, and this is exact. */
const src = readFileSync(new URL("../src/lib/domActions.js", import.meta.url), "utf8");
const fn = /export function findPlayerClickTarget[\s\S]*?\n}/.exec(src);

test("the position filter runs before ADP arbitration", () => {
  assert.ok(fn, "findPlayerClickTarget should still exist");
  const posAt = fn[0].indexOf("rowPosition(rowOf(node))");
  const adpAt = fn[0].indexOf("rivals.length > 1");
  assert.ok(posAt > -1, "the row's position must be consulted");
  assert.ok(adpAt > -1 && posAt < adpAt, "position is exact; ADP is a guess");
});

test("no surviving row means no target, not a wrong one", () => {
  /* Returning null sends the turn to the queue fallback. A missed pick is
   * recoverable; the wrong player is not. */
  const block = /if \(player\?\.pos\) \{[\s\S]*?\n  \}/.exec(fn[0]);
  assert.ok(block, "the position filter block should exist");
  assert.match(
    block[0],
    /if \(matches\.length === 0\) return null;/,
    "an empty match set after filtering must return null",
  );
});
