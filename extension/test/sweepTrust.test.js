import test from "node:test";
import assert from "node:assert/strict";
import { sweepTrust, MIN_ROWS_TO_TRUST } from "../src/lib/sweepTrust.js";

/* The failure this module exists to prevent. The room was showing a tab other
 * than Players, so the sweep walked a short list, reached its end honestly,
 * and read 60 of the 275 players the board still had available. The old rule
 * was a flat count of 60, so it marked the other 215 drafted — including
 * Allgeier, Bigsby, Coleman and Spears, all of whom were sitting in the room
 * with live ADPs. */
test("a short list that ends is not the whole board", () => {
  const { mark } = sweepTrust(60, true, 275, 0);
  assert.equal(mark, false);
});

test("nor is half of it", () => {
  assert.equal(sweepTrust(150, true, 275, 0).mark, false);
});

test("but a sweep that reads nearly all of it may mark", () => {
  assert.equal(sweepTrust(260, true, 275, 0).mark, true);
});

test("a sweep that never reached the end may not, however full", () => {
  assert.equal(sweepTrust(275, false, 275, 0).mark, false);
});

test("nor may one well short of the fullest view yet", () => {
  // 250 of 260 available clears the proportion on its own, but an earlier
  // sweep saw 275 — this room renders more than this pass managed to read.
  assert.equal(sweepTrust(250, true, 260, 275).mark, false);
});

test("the best view seen is carried forward, never lowered", () => {
  assert.equal(sweepTrust(100, true, 275, 275).best, 275);
  assert.equal(sweepTrust(300, true, 275, 275).best, 300);
});

test("freeing needs far less, since it only touches players actually seen", () => {
  const { free, mark } = sweepTrust(150, true, 275, 0);
  assert.equal(free, true);
  assert.equal(mark, false);
});

test("but a handful of rows is not evidence of anything", () => {
  assert.equal(sweepTrust(MIN_ROWS_TO_TRUST - 1, true, 60, 0).free, false);
  assert.equal(sweepTrust(MIN_ROWS_TO_TRUST - 1, true, 60, 0).mark, false);
});

test("an empty board cannot be used to justify marking", () => {
  // expected 0 makes every proportion trivially satisfied; the floor is what
  // stops a board that has not loaded from burying the room.
  assert.equal(sweepTrust(10, true, 0, 0).mark, false);
});
