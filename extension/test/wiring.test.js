/*
 * The overlay pulls every helper out of a dynamic import by destructuring,
 * and a name added to the declaration but missed in the assignment stays
 * undefined until the moment it is needed — mid-draft, inside a catch that
 * says nothing useful. Four separate debugging rounds went that way, which is
 * why the panel checks itself at load.
 *
 * That check needs a real browser. This one is the same comparison done by
 * reading the file, so it runs in milliseconds and fails the suite before a
 * broken tree can be loaded unpacked — which is how it reaches the browser,
 * since the extension is loaded from the working directory itself.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../src/content/overlay.js", import.meta.url), "utf8");
const names = (block) => new Set(block.match(/[\w$]+/g) || []);

test("every helper the load check asserts is actually imported", () => {
  const wiredBlock = /const wired = \{(.*?)\n  \};/s.exec(src);
  assert.ok(wiredBlock, "the load-time wiring check should still exist");

  const assigned = new Set();
  for (const block of src.matchAll(/\(\{([^}]*)\}\s*=\s*\n?\s*await import/gs)) {
    for (const name of names(block[1])) assigned.add(name);
  }

  const missing = [...names(wiredBlock[1])].filter((name) => !assigned.has(name));
  assert.deepEqual(missing, [],
    `declared in the wiring check but never destructured from an import: ${missing.join(", ")}`);
});

test("every helper used from a lib module is declared before use", () => {
  // A name assigned by destructuring but never declared would be an implicit
  // global in sloppy mode and a ReferenceError in a module.
  const declared = new Set();
  // Module scope as well as inside main: findBoardNames is declared at the
  // top of the file, not in the function body.
  for (const block of src.matchAll(/\n\s*let ([^;]+);/g)) {
    for (const name of names(block[1])) declared.add(name);
  }
  const assigned = new Set();
  for (const block of src.matchAll(/\(\{([^}]*)\}\s*=\s*\n?\s*await import/gs)) {
    for (const name of names(block[1])) assigned.add(name);
  }
  const undeclared = [...assigned].filter((name) => !declared.has(name));
  assert.deepEqual(undeclared, [],
    `destructured from an import without being declared: ${undeclared.join(", ")}`);
});
