import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { isMyTurn, looksLikeAFutureTurn, DEFAULT_TURN_PHRASES } from "../src/lib/turnDetect.js";

describe("isMyTurn", () => {
  test("matches a default phrase, case-insensitively", () => {
    assert.equal(isMyTurn("Round 3, Pick 4 — YOU'RE ON THE CLOCK"), true);
  });

  test("matches default phrase with punctuation and extra spacing", () => {
    assert.equal(isMyTurn("  You’re on the clock!!!  "), true);
  });

  test("no match when no phrase is present", () => {
    assert.equal(isMyTurn("Waiting for Team Bravo to pick..."), false);
  });

  test("empty page never matches", () => {
    assert.equal(isMyTurn(""), false);
  });

  test("respects a custom phrase list instead of the defaults", () => {
    const custom = ["ready to draft"];
    assert.equal(isMyTurn("You're on the clock", custom), false);
    assert.equal(isMyTurn("Ready to draft?", custom), true);
  });

  test("blank/whitespace-only phrases in the list are ignored, not matched against everything", () => {
    assert.equal(isMyTurn("any random text at all", ["", "   "]), false);
  });

  test("default export list is non-empty and lowercase", () => {
    assert.ok(DEFAULT_TURN_PHRASES.length > 0);
    for (const phrase of DEFAULT_TURN_PHRASES) assert.equal(phrase, phrase.toLowerCase());
  });
});

describe("looksLikeAFutureTurn", () => {
  test("the room's countdown is not a turn", () => {
    // Permanently on screen during everyone else's picks.
    assert.equal(looksLikeAFutureTurn("Dale's Pick \u2022 You're up in 11 Picks \u2022 Round 1, Pick 1"), true);
  });

  test("the ranking list's divider is not a turn", () => {
    assert.equal(looksLikeAFutureTurn("YOUR TURN - 22ND PICK"), true);
  });

  test("the real banner is not mistaken for one of them", () => {
    assert.equal(looksLikeAFutureTurn("YOUR TURN \u2022 ROUND 4, PICK 50"), false);
  });
});
