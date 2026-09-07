/*
 * Parsing the consensus ADP feed. The fixture is the shape the live endpoint
 * returned on 2026-09-06, including a defence and a kicker, since those are
 * the rows whose naming decides whether this source is usable at all.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { adpUrl, scoringFormat, parseAdpFeed } from "../src/lib/consensusAdp.js";

const FEED = {
  status: "Success",
  meta: { type: "PPR", teams: 12 },
  players: [
    { player_id: 5672, name: "Jahmyr Gibbs", position: "RB", team: "DET", adp: 1.4, bye: 6, stdev: 0.6 },
    { player_id: 5670, name: "Bijan Robinson", position: "RB", team: "ATL", adp: 2.4, bye: 11, stdev: 0.7 },
    { name: "Seattle Defense", position: "DEF", team: "SEA", adp: 140.2, bye: 11, stdev: 12.0 },
    { name: "Brandon Aubrey", position: "PK", team: "DAL", adp: 127.9, bye: 14, stdev: 9.0 },
    { name: "No ADP Guy", position: "WR", team: "FA", adp: 0, bye: null, stdev: null },
  ],
};

describe("parseAdpFeed", () => {
  test("keeps the fields the board needs, in ADP order", () => {
    const players = parseAdpFeed(FEED);
    assert.equal(players[0].name, "Jahmyr Gibbs");
    assert.equal(players[0].adp, 1.4);
    assert.equal(players[0].team, "DET");
    assert.equal(players[0].bye, 6);
  });

  test("carries defences and kickers under the names the board already uses", () => {
    // The reason this source was chosen: "Seattle Defense" and PK are exactly
    // what the bundled board says, so nothing has to be translated.
    const players = parseAdpFeed(FEED);
    assert.ok(players.find((p) => p.name === "Seattle Defense" && p.pos === "DEF"));
    assert.ok(players.find((p) => p.name === "Brandon Aubrey" && p.pos === "PK"));
  });

  test("drops rows with no usable ADP", () => {
    assert.equal(parseAdpFeed(FEED).some((p) => p.name === "No ADP Guy"), false);
  });

  test("survives a malformed response rather than throwing", () => {
    assert.deepEqual(parseAdpFeed(null), []);
    assert.deepEqual(parseAdpFeed({ players: "nope" }), []);
  });
});

describe("adpUrl", () => {
  test("asks for the league's own scoring and size", () => {
    const url = adpUrl({ scoring: "half_ppr", teams: 14, year: 2026 });
    assert.match(url, /half-ppr\?teams=14&year=2026/);
  });

  test("falls back to a size the feed publishes", () => {
    // It offers 8, 10, 12 and 14; anything else would return nothing at all.
    assert.match(adpUrl({ teams: 11, year: 2026 }), /teams=12/);
  });

  test("maps our scoring names to theirs", () => {
    assert.equal(scoringFormat("ppr"), "ppr");
    assert.equal(scoringFormat("standard"), "standard");
  });
});
