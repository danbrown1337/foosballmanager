/*
 * Node's built-in test runner (node:test) — no dependency, matching the
 * project's "nothing extra to install" rule for the extension.
 * Run: node --test extension/test/
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { findBoardNames, diffDrafted, parseRosterText, parseLeaguePage, normalizePosition, looksLikeAPlayer } from "../src/lib/textMatch.js";

const BOARD = new Set([
  "Jahmyr Gibbs", "Josh Allen", "Marvin Harrison Jr.", "A.J. Brown",
  "Amon-Ra St. Brown", "Puka Nacua",
]);

describe("findBoardNames", () => {
  test("finds names in a pick feed", () => {
    const page = "1.01 Jahmyr Gibbs Det - RB\n1.02 Puka Nacua LAR - WR";
    const found = findBoardNames(page, BOARD);
    assert.deepEqual([...found].sort(), ["Jahmyr Gibbs", "Puka Nacua"]);
  });

  test("finds names with punctuation", () => {
    const page = "Marvin Harrison Jr. Ari - WR and A.J. Brown Phi - WR";
    const found = findBoardNames(page, BOARD);
    assert.ok(found.has("Marvin Harrison Jr."));
    assert.ok(found.has("A.J. Brown"));
  });

  test("does not match inside a longer name", () => {
    // "Josh Allenson" must not register as "Josh Allen" being drafted.
    const found = findBoardNames("Josh Allenson went undrafted", BOARD);
    assert.equal(found.size, 0);
  });

  test("empty page finds nothing", () => {
    assert.equal(findBoardNames("", BOARD).size, 0);
  });

  test("unknown players are never invented", () => {
    assert.equal(findBoardNames("Some Guy Nobody Drafted", BOARD).size, 0);
  });
});

describe("diffDrafted", () => {
  test("appear mode reports new names", () => {
    const out = diffDrafted(new Set(["A"]), new Set(["A", "B"]), "appear");
    assert.deepEqual([...out], ["B"]);
  });

  test("disappear mode reports removed names", () => {
    const out = diffDrafted(new Set(["A", "B"]), new Set(["A"]), "disappear");
    assert.deepEqual([...out], ["B"]);
  });

  test("no change yields nothing", () => {
    assert.equal(diffDrafted(new Set(["A"]), new Set(["A"]), "appear").size, 0);
  });

  test("unknown mode defaults to appear", () => {
    const out = diffDrafted(new Set(["A"]), new Set(["A", "B"]), "whatever");
    assert.deepEqual([...out], ["B"]);
  });
});

describe("normalizePosition", () => {
  test("multi-eligible keeps the first", () => {
    assert.equal(normalizePosition("TE,QB"), "TE");
  });
  test("source aliases are normalized", () => {
    assert.equal(normalizePosition("PK"), "K");
    assert.equal(normalizePosition("DST"), "DEF");
  });
  test("whitespace and case", () => {
    assert.equal(normalizePosition(" rb , wr "), "RB");
  });
});

describe("looksLikeAPlayer", () => {
  for (const name of ["Josh Allen", "A.J. Brown", "Amon-Ra St. Brown"]) {
    test(`accepts real name: ${name}`, () => assert.ok(looksLikeAPlayer(name)));
  }
  for (const name of ["QB", "BN", "W/R/T", "", "  ", "12.5", "Week 3"]) {
    test(`rejects chrome/stats: "${name}"`, () => assert.ok(!looksLikeAPlayer(name)));
  }
});

describe("parseRosterText", () => {
  const SAMPLE = [
    "QB Josh Allen Buf - QB",
    "BN Jahmyr Gibbs Det - RB",
    "WR Ja'Marr Chase Cin - WR Q",
    "Taysom Hill NO - TE,QB",
    "Seattle Seahawks Sea - DEF",
    "Brandon Aubrey Dal - K",
    "Total Points 1234.5",
  ].join("\n");

  test("extracts every player", () => {
    assert.equal(parseRosterText(SAMPLE).length, 6);
  });

  test("team is uppercased", () => {
    const rows = Object.fromEntries(parseRosterText(SAMPLE).map((r) => [r.name, r]));
    assert.equal(rows["Josh Allen"].team, "BUF");
  });

  test("roster slot label is not folded into the name", () => {
    const names = parseRosterText(SAMPLE).map((r) => r.name);
    assert.ok(names.includes("Jahmyr Gibbs"));
  });

  test("multi-eligible collapses to one position", () => {
    const rows = Object.fromEntries(parseRosterText(SAMPLE).map((r) => [r.name, r]));
    assert.equal(rows["Taysom Hill"].pos, "TE");
  });

  test("stat rows are ignored", () => {
    const names = parseRosterText(SAMPLE).map((r) => r.name);
    assert.ok(!names.includes("Total Points"));
  });

  test("punctuation in names survives (matches the ADP board exactly)", () => {
    const rows = parseRosterText("Marvin Harrison Jr. Ari - WR");
    assert.equal(rows[0].name, "Marvin Harrison Jr.");
  });

  test("duplicates are collapsed", () => {
    assert.equal(parseRosterText("Josh Allen Buf - QB\nJosh Allen Buf - QB").length, 1);
  });

  test("empty input", () => {
    assert.deepEqual(parseRosterText(""), []);
  });
});

describe("parseLeaguePage", () => {
  const PAGE = [
    "Team Alpha",
    "Josh Allen Buf - QB",
    "Jahmyr Gibbs Det - RB",
    "Team Bravo",
    "Puka Nacua LAR - WR",
  ].join("\n");

  test("groups players under their team", () => {
    const teams = parseLeaguePage(PAGE);
    assert.deepEqual(Object.keys(teams).sort(), ["Team Alpha", "Team Bravo"]);
    assert.equal(teams["Team Alpha"].length, 2);
    assert.equal(teams["Team Bravo"].length, 1);
  });

  test("page without headings still yields players", () => {
    const teams = parseLeaguePage("Josh Allen Buf - QB");
    const total = Object.values(teams).reduce((n, v) => n + v.length, 0);
    assert.equal(total, 1);
  });
});

describe("findBoardNames — abbreviated names (Yahoo draft room)", () => {
  const board = new Set([
    "Jahmyr Gibbs", "Ja'Marr Chase", "Ashton Jeanty", "Tee Higgins",
    "Bijan Robinson", "Brian Robinson Jr.", "Marvin Harrison Jr.",
  ]);

  test("matches an initial and surname, as the draft room renders it", () => {
    const found = findBoardNames("RB J. Gibbs Det Bye 6", board);
    assert.equal(found.has("Jahmyr Gibbs"), true);
  });

  test("matches an upper-case surname from the last-pick banner", () => {
    const found = findBoardNames("Last: A. JEANTY (RB \u00b7 LV)", board);
    assert.equal(found.has("Ashton Jeanty"), true);
  });

  test("keeps apostrophes in surnames intact", () => {
    assert.equal(findBoardNames("J. Chase", board).has("Ja'Marr Chase"), true);
  });

  test("keys off the surname, not a generational suffix", () => {
    assert.equal(findBoardNames("M. Harrison", board).has("Marvin Harrison Jr."), true);
  });

  test("refuses to guess when an abbreviation is ambiguous", () => {
    // B. Robinson is both Bijan and Brian: crediting the wrong one marks a
    // player drafted who is still there to take.
    const found = findBoardNames("B. Robinson", board);
    assert.equal(found.has("Bijan Robinson"), false);
    assert.equal(found.has("Brian Robinson Jr."), false);
  });

  test("still matches full names where a page renders them", () => {
    assert.equal(findBoardNames("Jahmyr Gibbs", board).has("Jahmyr Gibbs"), true);
  });
});
