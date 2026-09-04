/*
 * Pure helpers only. parsePoolPage needs a real DOMParser, so it is verified
 * in domActions.check.js against Chromium rather than faked here.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { leagueIdFromUrl } from "../src/lib/yahooPool.js";

describe("leagueIdFromUrl", () => {
  test("reads the id from a league page", () => {
    assert.equal(leagueIdFromUrl("https://football.fantasysports.yahoo.com/f1/799857/players"), "799857");
  });

  test("reads it from a draft room url too", () => {
    assert.equal(leagueIdFromUrl("https://football.fantasysports.yahoo.com/draftclient/f1/10697624/4?auth=x"), "10697624");
  });

  test("returns null when there isn't one", () => {
    assert.equal(leagueIdFromUrl("https://sports.yahoo.com/"), null);
  });
});
