/*
 * Recording the pick the panel just made.
 *
 * Telling the engine "that one was mine" is what stops the second pick of a
 * snake turn repeating the first. The first attempt at it routed through
 * MARK_PICK, which is the popup's search-box door, and it failed in both
 * directions in one live draft:
 *
 *   "Vikings"   — no board player is named that (the board says "Minnesota
 *                 Defense"), so it threw. The throw landed inside the turn's
 *                 try block, after the click had already gone through, so the
 *                 turn was recorded as an error and the defense was never
 *                 marked. One pick later the engine still saw DEF unfilled
 *                 and took a second one, which cost the kicker.
 *   "Patriots"  — shares three letters with Pat Freiermuth, which was all the
 *                 fuzzy fallback wanted. A tight end was marked as my pick,
 *                 silently, and the roster came back 16 players deep.
 *
 * So: the draft path writes the name verbatim and cannot abort the turn, and
 * the fuzzy fallback refuses coincidences.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const overlay = readFileSync(new URL("../src/content/overlay.js", import.meta.url), "utf8");
const draftPath = /clickElement\(draftBtn\);([\s\S]*?)recordPickDecision/.exec(overlay);

test("the draft path records its own pick", () => {
  assert.ok(draftPath, "the auto-draft click path should still exist");
  assert.match(draftPath[1], /IMPORT_PICKS[\s\S]*?by:\s*"mine"/);
});

test("recording the pick cannot abort the turn", () => {
  assert.match(
    draftPath[1],
    /try\s*\{[\s\S]*?IMPORT_PICKS[\s\S]*?\}\s*catch/,
    "a failure to record must be caught — the click has already happened",
  );
});

test("the draft path never goes through the search box's resolver", () => {
  const code = draftPath[1].replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  assert.doesNotMatch(
    code,
    /type:\s*"MARK_PICK"/,
    "MARK_PICK throws on names the board spells differently, and guesses on the rest",
  );
});

/* The resolver itself, exercised through the same shape of data that broke
 * it. Kept as a table so a future loosening of the rule has to say out loud
 * which of these it is willing to get wrong. */
const BOARD = [
  "Pat Freiermuth", "Pat Bryant", "Minnesota Defense", "New England Defense",
  "Jahmyr Gibbs", "Bijan Robinson", "Brian Robinson Jr.",
];

/* A copy of the shipped rule, asserted against the source so it cannot drift
 * silently — resolvePlayer is not exported. */
test("the fuzzy fallback needs half the name, not three letters", () => {
  const src = readFileSync(new URL("../src/lib/snapshot.js", import.meta.url), "utf8");
  const fn = /function resolvePlayer[\s\S]*?\n}/.exec(src);
  assert.ok(fn, "resolvePlayer should still exist");
  assert.match(fn[0], /bestScore >= lower\.length \/ 2/, "the length floor should still be there");

  const resolve = (name) => {
    const exact = BOARD.find((n) => n.toLowerCase() === name.toLowerCase());
    if (exact) return exact;
    const lower = name.toLowerCase();
    let best = null, bestScore = 0;
    for (const n of BOARD) {
      const p = n.toLowerCase();
      let score = 0;
      while (score < lower.length && score < p.length && lower[score] === p[score]) score++;
      if (score > bestScore) { bestScore = score; best = n; }
    }
    return bestScore >= 3 && bestScore >= lower.length / 2 ? best : null;
  };

  assert.equal(resolve("Patriots"), null, "must not become Pat Freiermuth");
  assert.equal(resolve("Vikings"), null, "no board player is spelled that");
  assert.equal(resolve("jah"), "Jahmyr Gibbs", "a real prefix search still works");
  assert.equal(resolve("Bijan"), "Bijan Robinson");
  assert.equal(resolve("Minnesota Defense"), "Minnesota Defense", "exact still wins");
});
