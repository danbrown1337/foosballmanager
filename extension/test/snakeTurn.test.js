/*
 * Back-to-back picks at the snake's turn.
 *
 * At the turn of the snake you pick twice inside a couple of seconds, and for
 * the whole life of this project the second pick kept doubling up on the
 * first: two running backs at 10 and 11, two more at 30 and 31, two
 * quarterbacks at 70 and 71 — both of the quarterbacks taken under a need
 * override that said "you have 0 of 1 rostered", one pick apart.
 *
 * The engine was never at fault. Nothing told it the first pick was *mine*:
 * the roster reader runs on its own schedule, and the room's own pick
 * announcement is imported as "rival" on purpose. So the second call really
 * did see a roster without the first player in it, and answered correctly for
 * the question it was asked.
 *
 * Two tests, because the bug had two halves. The engine half: a satisfied
 * starting slot must not trigger a need override. The wiring half: the panel
 * must say so the moment it drafts, rather than leaving it to whichever
 * reader gets there first.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { autoPick } from "../src/engine/autopilot.js";
import { makePlayer, assignTiers } from "../src/engine/board.js";

const CONFIG = {
  league: { num_teams: 10 },
  roster: { starters: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DEF: 1 }, bench: 6 },
  autopilot: { strategy: "best_player_available", risk_tolerance: "balanced" },
};

let seq = 0;
const p = (name, pos, adp, extra = {}) => ({
  ...makePlayer({ rank: ++seq, name, team: extra.team ?? `T${seq}`, pos, adp,
                  adpSource: "consensus" }),
  ...extra,
});

/* Round 7 of a ten-team draft with every starting slot filled except
 * quarterback, and the quarterback run under way — enough of them gone that
 * the position is inside the cliff window, which is what fires the need
 * override in the first place. Only QB can be urgent here, so the test is
 * about the quarterback and nothing else. */
function atTheQbCliff(extraMine = []) {
  const mine = [
    p("My RB1", "RB", 10, { draftedBy: "mine" }),
    p("My RB2", "RB", 20, { draftedBy: "mine" }),
    p("My WR1", "WR", 30, { draftedBy: "mine" }),
    p("My WR2", "WR", 40, { draftedBy: "mine" }),
    p("My TE1", "TE", 50, { draftedBy: "mine" }),
    p("My FLEX", "RB", 55, { draftedBy: "mine" }),
    ...extraMine,
  ];
  const goneQbs = Array.from({ length: 9 }, (_, i) =>
    p(`Gone QB${i}`, "QB", 60 + i, { draftedBy: "rival" }));
  const filler = Array.from({ length: 60 - mine.length }, (_, i) =>
    p(`Rival${i}`, "RB", 300 + i, { draftedBy: "rival" }));
  const board = [
    p("Available QB", "QB", 73),
    p("Another QB", "QB", 74),
    p("Good Back", "RB", 70),
    p("Good Receiver", "WR", 71),
    p("Good End", "TE", 72),
  ];
  const players = [...mine, ...goneQbs, ...filler, ...board];
  assignTiers(players);
  return players;
}

test("the second pick of a snake turn does not repeat a slot the first one filled", () => {
  const first = autoPick(atTheQbCliff([]), CONFIG);
  assert.equal(first.player.pos, "QB", "the cliff should force the quarterback");
  assert.equal(first.needOverride, true);

  // The same turn, one pick later, with the first pick recorded as ours.
  const second = autoPick(
    atTheQbCliff([p("My QB", "QB", 73, { draftedBy: "mine" })]),
    CONFIG,
  );
  assert.notEqual(
    second.player.pos,
    "QB",
    `took a second quarterback with the slot already filled: ${second.reason}`,
  );
});

test("a filled starting slot is never described as unfilled", () => {
  const pick = autoPick(
    atTheQbCliff([p("My QB", "QB", 73, { draftedBy: "mine" })]),
    CONFIG,
  );
  assert.ok(
    !/QB is .* rostered/.test(pick.reason),
    `still citing a quarterback need: ${pick.reason}`,
  );
});

test("the panel claims its own pick the moment it makes it", () => {
  const src = readFileSync(new URL("../src/content/overlay.js", import.meta.url), "utf8");
  const draftPath = /clickElement\(draftBtn\);(.*?)recordPickDecision/s.exec(src);
  assert.ok(draftPath, "the auto-draft click path should still exist");
  assert.match(
    draftPath[1],
    /MARK_PICK[\s\S]*?by:\s*"mine"/,
    "drafting must record the pick as mine before the next pick is computed",
  );
});
