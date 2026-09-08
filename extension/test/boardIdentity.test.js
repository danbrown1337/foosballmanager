/*
 * Two players the draft room writes identically are a data bug, not a
 * matching problem.
 *
 * Yahoo abbreviates in the roster panel and in pick announcements — "B.
 * ROBINSON (RB · ATL)" — so first initial, surname, position and team are
 * every discriminator the room ever offers. When two players on the board
 * share all four, nothing downstream can tell them apart: the announcement
 * reader gives up ("couldn't match him to the board"), the roster reader
 * resolves to whichever it happens to hit, and the grader reports the wrong
 * player.
 *
 * That happened for six straight drafts. Bijan Robinson (ATL, ADP 2.3) was
 * drafted correctly at pick 11 every time, and the roster panel graded him D
 * — because the ADP file listed Brian Robinson Jr. on Atlanta too, and he is
 * a 49er. One wrong team string, and no amount of matching logic could have
 * saved it: the room genuinely did not say which Robinson it meant.
 *
 * So the board itself has to guarantee the room can always be understood.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const players = JSON.parse(
  readFileSync(new URL("../data/adp_2026_ppr.json", import.meta.url), "utf8"),
);

/* How the room writes him: first initial, then the rest of the name. */
function roomForm(name) {
  const parts = String(name).replace(/\./g, " ").trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return name.toLowerCase();
  return `${parts[0][0]}.${parts.slice(1).join(" ")}`.toLowerCase();
}

test("no two players are indistinguishable in a draft room", () => {
  const seen = new Map();
  const clashes = [];
  for (const p of players) {
    const key = `${roomForm(p.name)}|${p.pos}|${p.team}`;
    if (seen.has(key)) clashes.push(`${seen.get(key).name} / ${p.name} (${p.pos} ${p.team})`);
    else seen.set(key, p);
  }
  assert.deepEqual(
    clashes,
    [],
    `the room cannot tell these players apart — check the team column:\n  ${clashes.join("\n  ")}`,
  );
});

/* The weaker key is allowed to clash, because the team column rescues it —
 * but only while every such pair really does differ by team. This asserts the
 * rescue is doing work rather than passing by luck. */
test("players who share initial, surname and position differ by team", () => {
  const byWeakKey = new Map();
  for (const p of players) {
    const key = `${roomForm(p.name)}|${p.pos}`;
    if (!byWeakKey.has(key)) byWeakKey.set(key, []);
    byWeakKey.get(key).push(p);
  }
  for (const [key, group] of byWeakKey) {
    if (group.length < 2) continue;
    const teams = new Set(group.map((p) => p.team));
    assert.equal(
      teams.size,
      group.length,
      `${key}: ${group.map((p) => `${p.name} (${p.team})`).join(", ")}`,
    );
  }
});

test("Bijan Robinson is the only B. Robinson on Atlanta", () => {
  const atlantaBRobinsons = players.filter(
    (p) => p.team === "ATL" && roomForm(p.name) === "b.robinson",
  );
  assert.deepEqual(atlantaBRobinsons.map((p) => p.name), ["Bijan Robinson"]);
});
