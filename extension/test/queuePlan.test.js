/*
 * The queue is a plan, and this is what it has to guarantee.
 *
 * Yahoo drafts from the queue whenever the panel is not watching — a
 * backgrounded tab, a throttled poll, a turn that arrived inside a
 * fifty-second gap — and it spends it as a sequence, taking the topmost
 * surviving entry each time. Every failure below was produced by filling it
 * with a shortlist instead, which is a list of alternatives for one pick:
 *
 *   - the endgame queue read "Seahawks, Broncos, Texans", three defenses;
 *   - a roster needing one kicker and one defense with two picks left took
 *     two defenses and finished with the kicker slot empty;
 *   - at the turn of the snake, where two picks land seconds apart, it
 *     handed over two backs, and on another night two quarterbacks.
 *
 * All three are the same mistake, so they get the same test: every entry is
 * chosen as if everything above it is already on the roster.
 *
 * These run against the real bundled board through a small chrome shim,
 * because the interesting behaviour is in how the engine's own overrides
 * interact — a hand-built fixture would be testing the fixture.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const store = new Map();
globalThis.chrome = {
  storage: { local: {
    async get(key) { return store.has(key) ? { [key]: store.get(key) } : {}; },
    async set(obj) { for (const [k, v] of Object.entries(obj)) store.set(k, v); },
  } },
  runtime: { getURL: (p) => new URL(`../${p}`, import.meta.url).href },
};
globalThis.fetch = async (url) => ({
  async json() { return JSON.parse(readFileSync(fileURLToPath(url), "utf8")); },
});

const { queuePlan } = await import("../src/lib/snapshot.js");
const { Storage } = await import("../src/lib/storage.js");

const CONFIG = {
  league: { num_teams: 10, scoring: "ppr" },
  roster: { starters: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DEF: 1 }, bench: 6 },
  autopilot: { strategy: "best_player_available", risk_tolerance: "balanced", max_bench_per_pos: 3 },
  rivals: [],
};

/* Put a roster and a set of rival picks on the board. `mine` are spelled
 * exactly as the bundled ADP file spells them. */
async function setBoard(mine, rivalCount) {
  const adp = JSON.parse(readFileSync(new URL("../data/adp_2026_ppr.json", import.meta.url), "utf8"));
  const drafted = {};
  for (const name of mine) drafted[name] = "mine";
  let taken = 0;
  for (const p of adp) {
    if (taken >= rivalCount) break;
    if (drafted[p.name]) continue;
    drafted[p.name] = "rival";
    taken++;
  }
  await Storage.setConfig(CONFIG);
  await Storage.setDraftState({ drafted });
  return drafted;
}

/* Thirteen of fifteen spots filled, kicker and defense both empty — the exact
 * shape of the roster that finished a live draft with no kicker. */
const NEARLY_DONE = [
  "Jahmyr Gibbs", "Bijan Robinson", "Drake London", "George Pickens",
  "Kyle Pitts Sr.", "Caleb Williams", "Rico Dowdle", "Josh Downs",
  "Alec Pierce", "Rachaad White", "Bhayshul Tuten", "Jadarian Price",
  "Baker Mayfield",
];

test("two picks left, K and DEF empty — the plan takes one of each", async () => {
  await setBoard(NEARLY_DONE, 120);
  const plan = await queuePlan(5, { round: 14 });
  const positions = plan.map((p) => p.pos);
  assert.ok(positions.includes("K"), `no kicker in the plan: ${JSON.stringify(positions)}`);
  assert.ok(positions.includes("DEF"), `no defense in the plan: ${JSON.stringify(positions)}`);
  assert.equal(positions.filter((p) => p === "DEF").length, 1, "queued a second defense");
  assert.equal(positions.filter((p) => p === "K").length, 1, "queued a second kicker");
});

test("three picks left is already too late to be offering a fourth receiver", async () => {
  /* The exact board that finished a live draft with an empty kicker slot, one
   * pick earlier. The old queue came back "Sam LaPorta, Jaxson Dart, Makai
   * Lemon, Jalen Coker, Kyler Murray" — a tight end, two quarterbacks and two
   * receivers for three remaining spots, with no kicker or defense anywhere
   * in it, because it scored players instead of asking the engine. The plan
   * goes through the same decision the panel makes live, so the
   * roster-completion override fires here whether or not the kicker floor has
   * lifted yet. */
  await setBoard(NEARLY_DONE.filter((n) => n !== "Baker Mayfield"), 110);
  const plan = await queuePlan(5, { round: 13 });
  const positions = plan.map((p) => p.pos);
  assert.ok(
    positions.includes("K") && positions.includes("DEF"),
    `three spots left and the queue offers ${JSON.stringify(positions)}`,
  );
});

test("the plan never runs past the roster spots that are left", async () => {
  await setBoard(NEARLY_DONE, 120);
  const plan = await queuePlan(8, { round: 14 });
  assert.ok(plan.length <= 2, `13 of 15 filled but planned ${plan.length} picks`);
});

test("an entry never repeats a starting slot the entry above it just filled", async () => {
  // Mid-draft, quarterback still empty and the run under way: the first entry
  // should be the quarterback and the second should not be another one.
  await setBoard(["Jahmyr Gibbs", "Bijan Robinson", "Drake London", "George Pickens"], 60);
  const plan = await queuePlan(4, { round: 7 });
  assert.ok(plan.length >= 2, "expected at least two entries to compare");
  const qbs = plan.filter((p) => p.pos === "QB").length;
  assert.ok(qbs <= 1, `queued ${qbs} quarterbacks: ${JSON.stringify(plan.map((p) => `${p.name} (${p.pos})`))}`);
});

test("the plan is a private walk — it never writes the simulated picks back", async () => {
  const before = await setBoard(NEARLY_DONE, 120);
  await queuePlan(5, { round: 14 });
  const after = (await Storage.getDraftState()).drafted;
  assert.deepEqual(after, before, "queuePlan wrote its own simulated picks to the board");
});

test("early on, the plan is still ordinary best-available depth", async () => {
  await setBoard([], 20);
  const plan = await queuePlan(5, { round: 3 });
  assert.equal(plan.length, 5);
  assert.equal(new Set(plan.map((p) => p.name)).size, 5, "the same player twice");
  assert.ok(
    plan.every((p) => !["K", "DEF"].includes(p.pos)),
    `kicker or defense queued in round 3: ${JSON.stringify(plan.map((p) => p.pos))}`,
  );
});
