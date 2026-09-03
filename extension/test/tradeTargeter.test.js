import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { surplusAndDeficit, buildOffersForTeam } from "../src/engine/tradeTargeter.js";

function makeConfig(starters) {
  return { roster: { starters } };
}

describe("surplusAndDeficit", () => {
  const config = makeConfig({ QB: 1, RB: 2, WR: 2, TE: 1 });

  test("deep position is surplus", () => {
    const roster = ["A", "B", "C", "D", "E"].map((n) => ({ name: n, pos: "RB" }));
    const { surplus } = surplusAndDeficit(roster, config);
    assert.ok(surplus.includes("RB"));
  });

  test("thin position is deficit", () => {
    const roster = [{ name: "A", pos: "RB" }];
    const { deficit } = surplusAndDeficit(roster, config);
    assert.ok(deficit.includes("WR"));
    assert.ok(deficit.includes("TE"));
    assert.ok(deficit.includes("QB"));
  });

  test("a position is never both", () => {
    const roster = Array.from({ length: 6 }, (_, i) => ({ name: `P${i}`, pos: "RB" }));
    const { surplus, deficit } = surplusAndDeficit(roster, config);
    assert.ok(!surplus.some((p) => deficit.includes(p)));
  });

  test("kickers and defenses are ignored", () => {
    const config2 = makeConfig({ QB: 1, RB: 2, WR: 2, TE: 1, K: 1 });
    const roster = Array.from({ length: 5 }, (_, i) => ({ name: `K${i}`, pos: "K" }));
    const { surplus, deficit } = surplusAndDeficit(roster, config2);
    assert.ok(!surplus.includes("K") && !deficit.includes("K"));
  });
});

describe("buildOffersForTeam", () => {
  const config = makeConfig({ QB: 1, RB: 2, WR: 2, TE: 1 });
  const theirRoster = [
    { name: "Their Stud RB", pos: "RB" },
    { name: "Their RB2", pos: "RB" },
    { name: "Their RB3", pos: "RB" },
    { name: "Their RB4", pos: "RB" },
    { name: "Their RB5", pos: "RB" },
  ];

  function adpMap(overrides = {}) {
    const base = new Map([
      ["Their Stud RB", { adp: 5.0 }],
      ["Their RB2", { adp: 60.0 }],
      ["Their RB3", { adp: 70.0 }],
      ["Their RB4", { adp: 80.0 }],
      ["Their RB5", { adp: 90.0 }],
    ]);
    for (const [k, v] of Object.entries(overrides)) base.set(k, v);
    return base;
  }

  test("offers their best player at the surplus position", () => {
    const adp = adpMap({ "My Spare WR": { adp: 150.0 } });
    const offers = buildOffersForTeam(
      "Sharks", theirRoster, [{ name: "My Spare WR", pos: "WR" }], adp, config, 3
    );
    assert.ok(offers.length > 0 && offers[0].includes("Their Stud RB"));
  });

  test("big gap reads as genuinely lopsided", () => {
    const adp = adpMap({ "My Spare WR": { adp: 150.0 } });
    const offers = buildOffersForTeam(
      "Sharks", theirRoster, [{ name: "My Spare WR", pos: "WR" }], adp, config, 1
    );
    assert.ok(offers[0].includes("genuinely lopsided in your favor"));
  });

  test("small gap reads as a mild lowball", () => {
    const adp = adpMap({ "My Spare WR": { adp: 25.0 } });
    const offers = buildOffersForTeam(
      "Sharks", theirRoster, [{ name: "My Spare WR", pos: "WR" }], adp, config, 1
    );
    assert.ok(offers[0].includes("a mild lowball"));
  });

  test("warns when the offer actually favors them", () => {
    const adp = adpMap({ "My Stud WR": { adp: 1.0 } });
    const offers = buildOffersForTeam(
      "Sharks", theirRoster, [{ name: "My Stud WR", pos: "WR" }], adp, config, 1
    );
    assert.ok(offers[0].includes("don't send this one"));
  });

  test("respects the offer count", () => {
    const adp = adpMap({
      "My Spare WR": { adp: 150.0 },
      "My Spare TE": { adp: 160.0 },
    });
    const offers = buildOffersForTeam(
      "Sharks", theirRoster,
      [{ name: "My Spare WR", pos: "WR" }, { name: "My Spare TE", pos: "TE" }],
      adp, config, 1
    );
    assert.equal(offers.length, 1);
  });

  test("balanced roster yields no angle", () => {
    const balanced = [
      { name: "A", pos: "RB" }, { name: "B", pos: "RB" },
      { name: "C", pos: "WR" }, { name: "D", pos: "WR" },
      { name: "E", pos: "QB" }, { name: "F", pos: "TE" },
    ];
    const offers = buildOffersForTeam(
      "Sharks", balanced, [{ name: "My Spare WR", pos: "WR" }], adpMap(), config, 3
    );
    assert.deepEqual(offers, []);
  });

  test("players missing from the ADP board are skipped", () => {
    const offers = buildOffersForTeam(
      "Sharks", theirRoster, [{ name: "Undrafted Guy", pos: "WR" }], adpMap(), config, 3
    );
    assert.deepEqual(offers, []);
  });
});
