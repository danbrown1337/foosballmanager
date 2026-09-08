/*
 * The room's roster panel is the authority on what is mine.
 *
 * IMPORT_PICKS only ever adds, so a name marked "mine" in error stayed mine
 * for the rest of the draft. One draft's report came back picksMade 16 for 15
 * spots, another 17 — and an over-full roster is not a harmless miscount: it
 * drove `remaining` negative, emptied the queue plan, and cost the two turns
 * that depended on the plan being there.
 *
 * The page already knows. It renders your team every few seconds, and a
 * player it does not list is not on your team whatever the board recorded
 * earlier. The only thing it is wrong about is the pick made two seconds ago
 * that it has not rendered yet, which is what the grace list is for — without
 * it this would undo the pick it just made, the same fault from the other
 * side.
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

const { syncMyTeam } = await import("../src/lib/snapshot.js");
const { Storage } = await import("../src/lib/storage.js");

const set = (drafted) => Storage.setDraftState({ drafted });
const get = async () => (await Storage.getDraftState()).drafted;

test("a player the page does not list is not on my team", async () => {
  await set({ "Bijan Robinson": "mine", "Ghost Player": "mine", "Some Rival": "rival" });
  const { demoted } = await syncMyTeam(["Bijan Robinson"]);
  const after = await get();
  assert.equal(after["Bijan Robinson"], "mine");
  assert.equal(after["Ghost Player"], "rival", "the phantom should come off my roster");
  assert.deepEqual(demoted, ["Ghost Player"]);
});

test("demoting says nothing about availability — he stays drafted", async () => {
  /* Being wrong about whose he is does not mean he is free. The sweep already
   * puts genuinely available players back; guessing here would undo that. */
  await set({ "Ghost Player": "mine" });
  await syncMyTeam([]);
  assert.equal((await get())["Ghost Player"], "rival");
});

test("the pick made two seconds ago survives the sync", async () => {
  await set({ "Bijan Robinson": "mine", "Just Drafted": "mine" });
  const { demoted } = await syncMyTeam(["Bijan Robinson"], ["Just Drafted"]);
  assert.deepEqual(demoted, [], "the grace list should have spared him");
  assert.equal((await get())["Just Drafted"], "mine");
});

test("names on the page that the board missed are added", async () => {
  await set({ "Bijan Robinson": "mine" });
  await syncMyTeam(["Bijan Robinson", "James Cook III"]);
  assert.equal((await get())["James Cook III"], "mine");
});

test("a roster that already agrees reports no change", async () => {
  await set({ "Bijan Robinson": "mine", "Some Rival": "rival" });
  const { changed, demoted } = await syncMyTeam(["Bijan Robinson"]);
  assert.equal(changed, false);
  assert.deepEqual(demoted, []);
});

test("rivals are never touched", async () => {
  await set({ "Some Rival": "rival", "Another Rival": "rival" });
  await syncMyTeam(["Some Rival"]);
  const after = await get();
  assert.equal(after["Some Rival"], "mine", "the page says he is mine, so he is");
  assert.equal(after["Another Rival"], "rival");
});

/* The wiring half: the overlay must send the grace list, or the sync undoes
 * the pick it just made. */
const overlay = readFileSync(new URL("../src/content/overlay.js", import.meta.url), "utf8");

test("the roster read syncs rather than only adding", () => {
  const fn = /async function importMyTeam[\s\S]*?\n  }/.exec(overlay);
  assert.ok(fn, "importMyTeam should still exist");
  assert.match(fn[0], /type:\s*"SYNC_MY_TEAM"/);
  assert.match(fn[0], /keep:\s*recentPickNames\(\)/, "must spare the picks just made");
});

test("both draft paths mark their pick as recent", () => {
  const calls = overlay.match(/noteMyPick\(/g) || [];
  assert.ok(calls.length >= 3, `expected the two draft paths plus the helper, got ${calls.length}`);
});

test("a fallback pick does not log another player's alternatives", () => {
  const fn = /async function draftFromPlan[\s\S]*?\n  }\n/.exec(overlay);
  assert.ok(fn);
  const clear = fn[0].indexOf("currentAlternatives = null");
  const record = fn[0].indexOf("recordPickDecision(entry.name)");
  assert.ok(clear > -1 && record > -1 && clear < record,
    "clear the alternatives before recording the decision");
});
