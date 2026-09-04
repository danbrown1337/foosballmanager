/*
 * The queue shortlist: an ordered fallback chain for a single pick, built by
 * rolling the real engine forward rather than by slicing the board by ADP.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadPlayers, applyNotes, assignTiers } from "../src/engine/board.js";
import { topPicks, autoPick } from "../src/engine/autopilot.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const adp = JSON.parse(readFileSync(join(HERE, "..", "data", "adp_2026_ppr.json"), "utf8"));
const notes = JSON.parse(readFileSync(join(HERE, "..", "data", "player_notes_2026.json"), "utf8"));

const CONFIG = {
  league: { name: "T", num_teams: 12, scoring: "ppr" },
  roster: { starters: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DEF: 1 }, bench: 6, ir: 1 },
  autopilot: { strategy: "best_player_available", risk_tolerance: "balanced", max_bench_per_pos: 3 },
  rivals: [],
};

function freshBoard() {
  const players = loadPlayers(adp);
  applyNotes(players, notes);
  assignTiers(players);
  return players;
}

describe("topPicks", () => {
  test("returns the requested number of distinct players", () => {
    const picks = topPicks(freshBoard(), CONFIG, 5);
    assert.equal(picks.length, 5);
    assert.equal(new Set(picks.map((p) => p.name)).size, 5);
  });

  test("its first entry is exactly what the engine would pick now", () => {
    const players = freshBoard();
    const single = autoPick(players, CONFIG);
    assert.equal(topPicks(freshBoard(), CONFIG, 3)[0].name, single.player.name);
  });

  test("leaves the board untouched, so live state can be rolled forward safely", () => {
    const players = freshBoard();
    topPicks(players, CONFIG, 5);
    assert.equal(players.filter((p) => p.draftedBy).length, 0);
  });

  test("skips players already drafted", () => {
    const players = freshBoard();
    const first = autoPick(players, CONFIG).player;
    first.draftedBy = "rival";
    assert.equal(topPicks(players, CONFIG, 4).some((p) => p.name === first.name), false);
  });

  test("carries the engine's reasoning, not just names", () => {
    const [top] = topPicks(freshBoard(), CONFIG, 1);
    assert.ok(top.reason && top.reason.length > 0);
    assert.ok(top.pos && top.team);
  });

  test("asking for more than the board holds stops rather than repeating", () => {
    const players = freshBoard();
    for (const p of players.slice(5)) p.draftedBy = "rival";
    const picks = topPicks(players, CONFIG, 10);
    assert.ok(picks.length <= 5);
    assert.equal(new Set(picks.map((p) => p.name)).size, picks.length);
  });
});
