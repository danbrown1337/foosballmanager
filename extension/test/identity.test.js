/*
 * Joining sources by identity rather than by display string. The failure this
 * prevents is silent: a name that does not match drops that player's real ADP,
 * he falls back to list position, and the engine then treats a number that was
 * never an ADP as one.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeName, buildIndex, resolve } from "../src/lib/identity.js";

test("punctuation and spacing in a name carry no identity", () => {
  assert.equal(normalizeName("A.J. Brown"), "aj brown");
  assert.equal(normalizeName("AJ Brown"), "aj brown");
  assert.equal(normalizeName("Ja'Marr Chase"), "jamarr chase");
  assert.equal(normalizeName("Amon-Ra St. Brown"), "amon ra st brown");
});

test("neither do suffixes, which sources disagree about printing", () => {
  assert.equal(normalizeName("Travis Etienne Jr."), normalizeName("Travis Etienne"));
  assert.equal(normalizeName("James Cook III"), normalizeName("James Cook"));
  assert.equal(normalizeName("Kyle Pitts Sr."), normalizeName("Kyle Pitts"));
});

test("a two-word name is never shortened into nothing", () => {
  // "Sr" as an actual surname must survive; only a third-or-later part goes.
  assert.equal(normalizeName("Marcus Sr"), "marcus sr");
});

test("the join finds a player the raw string would have missed", () => {
  const feed = [{ name: "AJ Brown", team: "NE", pos: "WR", adp: 24 }];
  const index = buildIndex(feed);
  const hit = resolve(index, { name: "A.J. Brown", team: "NE", pos: "WR" });
  assert.equal(hit.adp, 24);
});

test("a changed team still resolves, since names outlive rosters", () => {
  const feed = [{ name: "Travis Etienne Jr.", team: "JAX", pos: "RB", adp: 60 }];
  const index = buildIndex(feed);
  assert.equal(resolve(index, { name: "Travis Etienne", team: "PHI", pos: "RB" }).adp, 60);
});

test("two players sharing a name resolve by team, and never by guess", () => {
  const feed = [
    { name: "Brian Robinson", team: "ATL", pos: "RB", adp: 152.9 },
    { name: "Brian Robinson", team: "WAS", pos: "RB", adp: 44 },
  ];
  const index = buildIndex(feed);
  assert.equal(resolve(index, { name: "Brian Robinson", team: "WAS", pos: "RB" }).adp, 44);
  // Same name, no team to separate them: nothing, rather than a coin flip.
  // A wrong join attaches another player's ADP, which is worse than none.
  assert.equal(resolve(index, { name: "Brian Robinson", team: "", pos: "RB" }), null);
});

test("an unknown player simply isn't found", () => {
  const index = buildIndex([{ name: "Someone Else", team: "KC", pos: "WR", adp: 30 }]);
  assert.equal(resolve(index, { name: "Nobody At All", team: "KC", pos: "WR" }), null);
});

test("a defence is identified by its team, not by whatever it is called", () => {
  // "Seattle Defense", "Seahawks", "Seattle Seahawks" and "SEA" are one thing,
  // and every source picks a different one of them.
  const feed = [{ name: "Seattle Seahawks", team: "SEA", pos: "DEF", adp: 109 }];
  const index = buildIndex(feed);
  assert.equal(resolve(index, { name: "Seattle Defense", team: "SEA", pos: "DEF" }).adp, 109);
  assert.equal(resolve(index, { name: "Seahawks", team: "SEA", pos: "DEF" }).adp, 109);
  assert.equal(resolve(index, { name: "Seattle Defense", team: "DEN", pos: "DEF" }), null);
});
