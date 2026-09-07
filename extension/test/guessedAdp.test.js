import test from "node:test";
import assert from "node:assert/strict";
import { autoPick, guessPenalty, GUESSED_ADP_PENALTY, backupPenalty, BACKUP_PENALTY } from "../src/engine/autopilot.js";
import { makePlayer, assignTiers } from "../src/engine/board.js";

const CONFIG = {
  league: { num_teams: 10 },
  roster: { starters: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DEF: 1 }, bench: 6 },
  autopilot: { strategy: "best_player_available", risk_tolerance: "balanced" },
};

function board(rows) {
  const players = rows.map((r) => makePlayer(r));
  assignTiers(players);
  return players;
}

test("a rank standing in for an ADP is charged; a real one isn't", () => {
  assert.equal(guessPenalty({ adpSource: "rank" }, CONFIG), GUESSED_ADP_PENALTY);
  for (const source of ["pool", "consensus", "room", null]) {
    assert.equal(guessPenalty({ adpSource: source }, CONFIG), 0);
  }
});

/* The pick this exists to prevent. A receiver at list position 113 whom no
 * room drafts, sitting next to a back with a real ADP of 140: on the raw
 * numbers the receiver looks like the better value by nearly thirty places. */
test("a real ADP behind a guessed one still wins", () => {
  const players = board([
    { rank: 113, name: "Guessed Receiver", team: "DAL", pos: "WR", adp: 113, adpSource: "rank" },
    { rank: 140, name: "Real Back", team: "DEN", pos: "RB", adp: 140, adpSource: "consensus" },
  ]);
  assert.equal(autoPick(players, CONFIG).player.name, "Real Back");
});

test("but he is still there at the end, rather than an empty slot", () => {
  const players = board([
    { rank: 113, name: "Guessed Receiver", team: "DAL", pos: "WR", adp: 113, adpSource: "rank" },
  ]);
  assert.equal(autoPick(players, CONFIG).player.name, "Guessed Receiver");
});

test("the penalty is not enough to pass over a genuinely better player", () => {
  // Twenty places apart, and the guessed one is far better on the board: the
  // charge is meant to break a near tie, not to blacklist him.
  const players = board([
    { rank: 20, name: "Guessed Star", team: "DAL", pos: "WR", adp: 20, adpSource: "rank" },
    { rank: 95, name: "Real Journeyman", team: "DEN", pos: "RB", adp: 95, adpSource: "consensus" },
  ]);
  assert.equal(autoPick(players, CONFIG).player.name, "Guessed Star");
});

test("a player the room proves has no ADP is not offered at all", () => {
  // undrafted is what buildPlayers sets once the room has been read widely
  // enough for absence from its ADP column to mean a dash.
  const players = board([
    { rank: 113, name: "Proven Dash", team: "DAL", pos: "WR", adp: 113, adpSource: "rank" },
    { rank: 300, name: "Deep Bench", team: "DEN", pos: "RB", adp: 300, adpSource: "consensus" },
  ]);
  players[0].undrafted = true;
  assert.equal(autoPick(players, CONFIG).player.name, "Deep Bench");
});

/* Handcuffs. A 15-round mock came back with three of its four running backs
 * sitting behind somebody else's starter, bought at up to two rounds above
 * market for the chance that starter gets hurt. */
test("somebody else's backup is charged; your own handcuff is not", () => {
  const players = board([
    { rank: 2, name: "Bijan Robinson", team: "ATL", pos: "RB", adp: 2.3, adpSource: "consensus" },
    { rank: 152, name: "Brian Robinson", team: "ATL", pos: "RB", adp: 152.9, adpSource: "consensus" },
  ]);
  const [starter, backup] = players;
  assert.equal(backupPenalty(backup, [], players, CONFIG), BACKUP_PENALTY.RB);
  // Once you hold the starter, the insurance pays out to you.
  assert.equal(backupPenalty(backup, [starter], players, CONFIG), 0);
  // And the starter himself is never a backup.
  assert.equal(backupPenalty(starter, [], players, CONFIG), 0);
});

test("a committee is not a backup", () => {
  // Twenty places apart: both of these play every week.
  const players = board([
    { rank: 40, name: "Lead Back", team: "GB", pos: "RB", adp: 40, adpSource: "consensus" },
    { rank: 58, name: "Change Of Pace", team: "GB", pos: "RB", adp: 58, adpSource: "consensus" },
  ]);
  assert.equal(backupPenalty(players[1], [], players, CONFIG), 0);
});

test("a team's second receiver is barely charged, unlike its second back", () => {
  const wrs = board([
    { rank: 5, name: "WR1", team: "CIN", pos: "WR", adp: 5, adpSource: "consensus" },
    { rank: 70, name: "WR2", team: "CIN", pos: "WR", adp: 70, adpSource: "consensus" },
  ]);
  const rbs = board([
    { rank: 5, name: "RB1", team: "CIN", pos: "RB", adp: 5, adpSource: "consensus" },
    { rank: 70, name: "RB2", team: "CIN", pos: "RB", adp: 70, adpSource: "consensus" },
  ]);
  const wrCharge = backupPenalty(wrs[1], [], wrs, CONFIG);
  const rbCharge = backupPenalty(rbs[1], [], rbs, CONFIG);
  assert.ok(rbCharge > wrCharge * 3, `${rbCharge} vs ${wrCharge}`);
});
