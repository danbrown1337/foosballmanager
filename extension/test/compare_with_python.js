#!/usr/bin/env node
/*
 * Golden-master test: replays the exact same full-draft simulation that
 * produced golden_draft.json (via scripts/simulate_draft.py), but through
 * the ported JS engine, and diffs every single pick. This is the strongest
 * evidence the port is correct — far stronger than reading the code side by
 * side, since it exercises real tiering, notes-driven scoring, and every
 * guardrail across a realistic 150-pick draft.
 *
 * Regenerate the fixture whenever autopilot.py/board.py change:
 *   python3 scripts/simulate_draft.py config/league.yaml > extension/test/golden_draft.json
 * The fixture carries both the picks AND the resolved config Python used,
 * so this test needs no YAML parser of its own.
 *
 * Run:
 *   node extension/test/compare_with_python.js
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

import { loadPlayers, applyNotes, assignTiers } from "../src/engine/board.js";
import { autoPick } from "../src/engine/autopilot.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");

function loadJSON(path) {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function buildFreshBoard() {
  const adpRows = loadJSON(join(ROOT, "extension", "data", "adp_2026_ppr.json"));
  const notes = loadJSON(join(ROOT, "extension", "data", "player_notes_2026.json"));
  const players = loadPlayers(adpRows);
  applyNotes(players, notes);
  assignTiers(players);
  return players;
}

function main() {
  const fixturePath = process.argv[2] || join(HERE, "golden_draft.json");
  const fixture = loadJSON(fixturePath);
  const { config, picks: golden } = fixture;
  console.log(`Fixture: ${fixturePath}`);

  const players = buildFreshBoard();

  const numTeams = config.league.num_teams;
  const teamRosters = Array.from({ length: numTeams }, () => new Set());

  let mismatches = 0;

  for (const expected of golden) {
    const team = (expected.pickNo - 1) % numTeams;
    assert.equal(team, expected.team, `pick ${expected.pickNo}: team index drifted`);

    const mineNames = teamRosters[team];
    for (const p of players) {
      if (mineNames.has(p.name)) p.draftedBy = "mine";
      else if (teamRosters.some((r) => r.has(p.name))) p.draftedBy = "rival";
      else p.draftedBy = null;
    }

    const decision = autoPick(players, config);
    if (!decision) {
      console.error(`Pick ${expected.pickNo}: JS engine returned no decision, Python picked ${expected.player}`);
      mismatches++;
      continue;
    }

    const ok =
      decision.player.name === expected.player &&
      decision.needOverride === expected.needOverride;

    if (!ok) {
      mismatches++;
      console.error(
        `MISMATCH pick ${expected.pickNo} (team ${team}): ` +
          `python="${expected.player}" (override=${expected.needOverride}) ` +
          `js="${decision.player.name}" (override=${decision.needOverride})`
      );
      console.error(`  python reason: ${expected.reason}`);
      console.error(`  js reason:     ${decision.reason}`);
    }

    teamRosters[team].add(decision.player.name);
  }

  console.log(`Compared ${golden.length} picks across ${numTeams} teams.`);
  if (mismatches > 0) {
    console.error(`FAILED: ${mismatches} mismatch(es) between Python and JS engines.`);
    process.exit(1);
  }
  console.log("PASS: JS engine matches Python pick-for-pick, including every guardrail trigger.");
}

main();
