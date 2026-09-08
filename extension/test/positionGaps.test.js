/*
 * Positions the imported pool cannot cover.
 *
 * The pool is the user's own league player list, and Yahoo only lists
 * positions that league uses. This league starts no kicker, so its list has
 * none — and a mock room that does start one leaves the engine drafting
 * blind. The bundled file carries eleven kickers; a fourteen-team mock drafts
 * fourteen, and one live draft announced five the board had never heard of:
 * Smack, McPherson, Pineiro, Santos and Reichard.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { parseAdpFeed } from "../src/lib/consensusAdp.js";
import { normalizePos } from "../src/engine/board.js";

/* A slice of the real feed, captured 2026-09-08. */
const FEED = {
  players: [
    { name: "Brandon Aubrey", team: "DAL", position: "PK", adp: 126.4, bye: 14 },
    { name: "Chris Boswell", team: "PIT", position: "PK", adp: 152.0, bye: 9 },
    { name: "Cairo Santos", team: "CHI", position: "PK", adp: 168.0, bye: 10 },
    { name: "Will Reichard", team: "MIN", position: "PK", adp: 171.0, bye: 6 },
    { name: "Bijan Robinson", team: "ATL", position: "RB", adp: 2.3, bye: 11 },
  ],
};

test("the feed carries kickers, under Yahoo's own label", () => {
  const rows = parseAdpFeed(FEED);
  const kickers = rows.filter((r) => normalizePos(r.pos) === "K");
  assert.equal(kickers.length, 4);
  // "PK" is the feed's spelling; the engine only ever sees K.
  assert.equal(normalizePos("PK"), "K");
});

test("each one arrives priced and with a bye", () => {
  // A position filled from here has no other source for a bye — the pool that
  // would normally supply it is the very thing that lacks the position.
  const santos = parseAdpFeed(FEED).find((r) => r.name === "Cairo Santos");
  assert.equal(santos.adp, 168.0);
  assert.equal(santos.bye, 10);
  assert.equal(santos.team, "CHI");
});

test("the kickers a live draft announced are in the feed", () => {
  // Santos and Reichard were both announced in a room and matched nothing on
  // our board, because the bundled file does not carry them.
  const names = parseAdpFeed(FEED).map((r) => r.name);
  assert.ok(names.includes("Cairo Santos"));
  assert.ok(names.includes("Will Reichard"));
});
