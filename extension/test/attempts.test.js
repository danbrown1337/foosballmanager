import test from "node:test";
import assert from "node:assert/strict";
import { Attempts } from "../src/lib/attempts.js";

function clock(start = 0) {
  const c = { t: start, now: () => c.t };
  return c;
}

test("a target is tried the full count before it rests", () => {
  const c = clock();
  const a = new Attempts({ tries: 3, restMs: 1000, now: c.now });
  assert.equal(a.fail("Jeanty"), false);
  assert.equal(a.resting("Jeanty"), false);
  assert.equal(a.fail("Jeanty"), false);
  assert.equal(a.fail("Jeanty"), true); // this one put him to rest
  assert.equal(a.resting("Jeanty"), true);
});

test("resting ends, because most of these failures are transient", () => {
  const c = clock();
  const a = new Attempts({ tries: 1, restMs: 1000, now: c.now });
  a.fail("Olave");
  assert.equal(a.resting("Olave"), true);
  c.t += 1001;
  assert.equal(a.resting("Olave"), false);
});

test("success clears the record", () => {
  const c = clock();
  const a = new Attempts({ tries: 2, restMs: 1000, now: c.now });
  a.fail("Smith");
  a.succeed("Smith");
  assert.equal(a.fail("Smith"), false); // counting started over
  assert.equal(a.resting("Smith"), false);
});

test("targets rest independently", () => {
  const c = clock();
  const a = new Attempts({ tries: 1, restMs: 1000, now: c.now });
  a.fail("Jeanty");
  assert.deepEqual(a.restingKeys(), ["Jeanty"]);
  assert.equal(a.resting("Olave"), false);
});

test("the loop that spun a whole draft now runs out of names to retry", () => {
  const c = clock();
  const a = new Attempts({ tries: 3, restMs: 90_000, now: c.now });
  const shortlist = ["Jeanty", "Smith", "Olave", "Williams"];
  let attempts = 0;
  // Twenty cycles of a panel that can confirm none of them.
  for (let cycle = 0; cycle < 20; cycle++) {
    for (const name of shortlist) {
      if (a.resting(name)) continue;
      attempts++;
      a.fail(name);
    }
    c.t += 4000; // the poll interval
  }
  // Three tries each, then rest — not eighty sweeps of the whole player list.
  assert.equal(attempts, 12);
});
