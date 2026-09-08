/*
 * Reading Yahoo's own record of what has been drafted, instead of inferring
 * it. Captured from a finished mock on 2026-09-07 — the same draft the engine
 * update spec graded.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { parseDraftResults } from "../src/lib/textMatch.js";

const REAL = `Thank you for drafting with Yahoo,
good luck this season!
Daniel
Coin Toss - H2H
Drafted 7th
Roster
Round 1, Pick 7 (7th Overall)
Jaxon Smith-Njigba Sea - WR
Round 2, Pick 8 (22nd Overall)
A.J. Brown NE - WR
Round 3, Pick 7 (35th Overall)
Trey McBride Ari - TE
Round 4, Pick 8 (50th Overall)
Luther Burden III Chi - WR
Round 9, Pick 7 (119th Overall)
Chris Rodriguez Jr. Jax - RB
Round 14, Pick 8 (190th Overall)
Jason Myers Sea - K
Round 15, Pick 7 (203rd Overall)
Chiefs KC - DEF
You have been put into autopick mode due to inactivity.`;

test("reads every pick, with its round and overall number", () => {
  const picks = parseDraftResults(REAL);
  assert.equal(picks.length, 7);
  assert.deepEqual(picks[0], {
    round: 1, pick: 7, overall: 7,
    name: "Jaxon Smith-Njigba", team: "SEA", pos: "WR",
  });
  assert.equal(picks.at(-1).round, 15);
  assert.equal(picks.at(-1).overall, 203);
});

test("full names, so nothing has to be disambiguated", () => {
  // The available list writes "B. ROBINSON" for two different Atlanta backs.
  // This view writes the name out, which is the whole point of reading it.
  const picks = parseDraftResults(REAL);
  assert.ok(picks.some((p) => p.name === "A.J. Brown"));
  assert.ok(picks.some((p) => p.name === "Chris Rodriguez Jr."));
});

test("a defence keeps its team, whatever the room calls it", () => {
  const picks = parseDraftResults(REAL);
  const def = picks.find((p) => p.pos === "DEF");
  assert.deepEqual({ name: def.name, team: def.team }, { name: "Chiefs", team: "KC" });
});

test("prose around the picks is ignored", () => {
  // The surrounding page is a thank-you note, a league name and an autopick
  // warning; none of it looks like a pick and none of it is read as one.
  assert.equal(parseDraftResults("Thank you for drafting with Yahoo").length, 0);
  assert.equal(parseDraftResults("Round 3 of the playoffs").length, 0);
});

test("a header with no player under it is not a pick", () => {
  assert.equal(parseDraftResults("Round 1, Pick 7 (7th Overall)\nOn the clock").length, 0);
});

test("a blank line between header and name doesn't lose the pick", () => {
  const picks = parseDraftResults("Round 2, Pick 8 (22nd Overall)\n\n  \nA.J. Brown NE - WR");
  assert.equal(picks.length, 1);
  assert.equal(picks[0].name, "A.J. Brown");
});

test("the same player listed twice is one pick", () => {
  const twice = `Round 1, Pick 7 (7th Overall)
Jaxon Smith-Njigba Sea - WR
Round 1, Pick 7 (7th Overall)
Jaxon Smith-Njigba Sea - WR`;
  assert.equal(parseDraftResults(twice).length, 1);
});

/* What the Picks panel read must ignore.
 *
 * Opening that panel re-renders the virtualised player list, so its rows
 * appear as newly-added text alongside the pick list. Searching that text for
 * any known name reported 118 picks in a room that had made 96, and the next
 * sweep put 109 wrongly-buried players back. Only the room's own numbered
 * pick lines count. */
test("player-list rows mixed in with the pick list are not picks", () => {
  const mixed = `Round 6, Pick 78 (78th Overall)
Tony Pollard Ten - RB
J. Chase	WR	Cin	Bye 10	3	4.2	10	280.11
D. Achane	RB	Mia	Bye 12	4	5.1	12	265.40
Round 7, Pick 91 (91st Overall)
Rico Dowdle Car - RB`;
  const picks = parseDraftResults(mixed);
  assert.deepEqual(picks.map((p) => p.name), ["Tony Pollard", "Rico Dowdle"]);
});

test("a panel with no numbered lines yields nothing at all", () => {
  // Rather than falling back to "any name here must be drafted", which is
  // exactly the guess that caused the over-marking.
  const listOnly = `J. Chase	WR	Cin	Bye 10	3	4.2
D. Achane	RB	Mia	Bye 12	4	5.1`;
  assert.deepEqual(parseDraftResults(listOnly), []);
});
