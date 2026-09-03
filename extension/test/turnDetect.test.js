import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { isMyTurn, DEFAULT_TURN_PHRASES } from "../src/lib/turnDetect.js";

describe("isMyTurn", () => {
  test("matches a default phrase, case-insensitively", () => {
    assert.equal(isMyTurn("Round 3, Pick 4 — YOU'RE ON THE CLOCK"), true);
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
