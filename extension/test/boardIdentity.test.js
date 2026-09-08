/*
 * Two players the draft room writes identically need something else to tell
 * them apart.
 *
 * Yahoo abbreviates in the roster panel and in pick announcements — "B.
 * ROBINSON (RB · ATL)" — so first initial, surname, position and team are
 * every discriminator the text ever offers. Bijan Robinson and Brian
 * Robinson Jr. are both Atlanta running backs, so all four match, for two
 * players a hundred and fifty ADP places apart. That is not a data error to
 * be corrected; it is simply true, and it cost a second-round pick more than
 * once while the panel searched for a naming rule that could not exist.
 *
 * The markup was never ambiguous. Each row carries data-id, and the headshot
 * URL ends in the same number: Bijan is 40055, Brian is 34054. So the rule
 * this file enforces is not "no collisions" — it is that every colliding pair
 * carries a Yahoo id, and that the matcher consults it before falling back to
 * guessing from ADP.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const players = JSON.parse(
  readFileSync(new URL("../data/adp_2026_ppr.json", import.meta.url), "utf8"),
);

/* How the room writes him: first initial, surname, suffix dropped.
 *
 * Yahoo's roster panel showed plain "B. Robinson" for the player whose row
 * carried data-id 34054 — Brian Robinson Jr. The suffix is not written, so a
 * form that keeps it would report these two as distinguishable when the room
 * has just proved they are not. */
const SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv", "v"]);
function roomForm(name) {
  const parts = String(name).replace(/\./g, " ").trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return name.toLowerCase();
  const rest = parts.slice(1).filter((w) => !SUFFIXES.has(w.toLowerCase()));
  if (rest.length === 0) return name.toLowerCase();
  return `${parts[0][0]}.${rest.join(" ")}`.toLowerCase();
}

const yahooIds = JSON.parse(
  readFileSync(new URL("../data/yahoo_ids.json", import.meta.url), "utf8"),
);

test("players the room writes identically carry a Yahoo id", () => {
  const seen = new Map();
  const clashes = [];
  for (const p of players) {
    const key = `${roomForm(p.name)}|${p.pos}|${p.team}`;
    if (seen.has(key)) clashes.push([seen.get(key), p]);
    else seen.set(key, p);
  }
  for (const [a, b] of clashes) {
    for (const p of [a, b]) {
      assert.ok(
        yahooIds[p.name],
        `${a.name} and ${b.name} are identical in the room (${p.pos} ${p.team}) ` +
        `and ${p.name} has no Yahoo id — nothing can tell them apart at a turn`,
      );
    }
    assert.notEqual(
      yahooIds[a.name], yahooIds[b.name],
      `${a.name} and ${b.name} share a Yahoo id`,
    );
  }
});

test("the pair that has cost real picks is covered", () => {
  // Both are Atlanta running backs; Yahoo confirms 40055 and 34054.
  assert.equal(yahooIds["Bijan Robinson"], "40055");
  assert.equal(yahooIds["Brian Robinson Jr."], "34054");
  const atlanta = players.filter(
    (p) => p.team === "ATL" && roomForm(p.name) === "b.robinson",
  );
  assert.equal(atlanta.length, 2, "both Robinsons are Atlanta backs — Yahoo says so");
});

test("every Yahoo id names a player actually on the board", () => {
  const names = new Set(players.map((p) => p.name));
  for (const name of Object.keys(yahooIds)) {
    assert.ok(names.has(name), `${name} has a Yahoo id but is not on the board`);
  }
});

test("the id path is consulted before ADP arbitration", () => {
  /* ADP is a proxy: it needs the room to publish a number and gives up when
   * two rows are close, which is exactly how the wrong Robinson kept getting
   * drafted from a room that prints no ADP for bench backs. The id is exact,
   * so it has to run first. */
  const dom = readFileSync(new URL("../src/lib/domActions.js", import.meta.url), "utf8");
  const fn = /export function findPlayerClickTarget[\s\S]*?\n}/.exec(dom);
  assert.ok(fn, "findPlayerClickTarget should still exist");
  const idAt = fn[0].indexOf("player?.yahooId");
  const adpAt = fn[0].indexOf("rivals.length > 1");
  assert.ok(idAt > -1, "the Yahoo id must be used when matching rows");
  assert.ok(adpAt > -1 && idAt < adpAt, "the id has to settle it before ADP guesses");
});
