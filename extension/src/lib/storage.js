/*
 * Everything the extension remembers, in chrome.storage.local — entirely
 * on the user's own machine, never sent anywhere. This replaces the
 * filesystem-based profiles/ system the CLI uses; a Chrome extension has
 * no filesystem access, and chrome.storage.local is scoped to the browser
 * profile it's installed in, which is a natural per-person boundary of its
 * own — install it in your own Chrome profile, and it's already yours.
 */

import { DEFAULT_TURN_PHRASES } from "./turnDetect.js";
import { DEFAULT_CONFIRM_PHRASES } from "./domActions.js";

const KEYS = {
  config: "fm_config",
  draftState: "fm_draft_state",
  myRoster: "fm_my_roster",
  leagueRosters: "fm_league_rosters",
  pollMode: "fm_poll_mode",
  autoDraftEnabled: "fm_auto_draft_enabled",
  autoDraftFullyAutomatic: "fm_auto_draft_fully_automatic",
  turnPhrases: "fm_turn_phrases",
  confirmPhrases: "fm_confirm_phrases",
  practice: "fm_practice",
  queueEnabled: "fm_queue_enabled",
  pool: "fm_pool",
};

/* Yahoo's standard mock draft room starts one W/R/T flex and a kicker; the
 * league this was built for starts two flex and no kicker at all. Practising
 * in a mock with the real settings loaded means the engine treats every
 * kicker as unrostable (autopilot.js caps a position with no starter slot at
 * zero), so it would finish the mock with an empty K slot and let Yahoo
 * autopick one. Practice mode swaps these in, and puts the real ones back. */
export const MOCK_STARTERS = { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DEF: 1 };

// Matches the confirmed real starter construction: 1 QB, 2 RB, 2 WR, 1 TE,
// 2 W/R/T flex, 1 DEF — no kicker. Same defaults as config/league.yaml.
export const DEFAULT_CONFIG = {
  league: {
    name: "My League",
    num_teams: 10,
    scoring: "ppr",
  },
  roster: {
    starters: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 2, DEF: 1 },
    bench: 6,
    ir: 1,
  },
  autopilot: {
    strategy: "best_player_available",
    risk_tolerance: "balanced",
    max_bench_per_pos: 3,
  },
  rivals: [],
};

async function get(key, fallback) {
  const result = await chrome.storage.local.get(key);
  return key in result ? result[key] : fallback;
}

async function set(key, value) {
  await chrome.storage.local.set({ [key]: value });
}

export const Storage = {
  async getConfig() {
    return get(KEYS.config, DEFAULT_CONFIG);
  },
  async setConfig(config) {
    return set(KEYS.config, config);
  },

  async getDraftState() {
    return get(KEYS.draftState, { drafted: {} });
  },
  async setDraftState(state) {
    return set(KEYS.draftState, state);
  },
  async resetDraftState() {
    return set(KEYS.draftState, { drafted: {} });
  },

  async getMyRoster() {
    return get(KEYS.myRoster, []);
  },
  async setMyRoster(roster) {
    return set(KEYS.myRoster, roster);
  },

  async getLeagueRosters() {
    return get(KEYS.leagueRosters, {}); // { teamName: [{name,pos,team}] }
  },
  async setLeagueRosters(rosters) {
    return set(KEYS.leagueRosters, rosters);
  },

  // "appear" (default) for a picks feed, "disappear" for an
  // available-player pool — see diffDrafted() in lib/textMatch.js. Remembered
  // across page loads so a draft spanning many page visits doesn't need
  // re-selecting it every time.
  async getPollMode() {
    // "auto" tolerates both room layouts (a picks feed where names appear,
    // a player pool where they disappear). Defaulting to one of them meant
    // the tolerant path only ran if you knew to pick it from the dropdown.
    return get(KEYS.pollMode, "auto");
  },
  async setPollMode(mode) {
    return set(KEYS.pollMode, mode);
  },

  // Auto-draft is off by default and, even when on, defaults to "auto-fill
  // only" (select the recommended player, leave Yahoo's own confirm click
  // to you) rather than fully unattended — see content/overlay.js.
  async getAutoDraftEnabled() {
    return get(KEYS.autoDraftEnabled, false);
  },
  async setAutoDraftEnabled(enabled) {
    return set(KEYS.autoDraftEnabled, enabled);
  },
  async getAutoDraftFullyAutomatic() {
    return get(KEYS.autoDraftFullyAutomatic, false);
  },
  async setAutoDraftFullyAutomatic(enabled) {
    return set(KEYS.autoDraftFullyAutomatic, enabled);
  },
  /* Stored phrases ADD to the defaults rather than replacing them.
   *
   * A list saved by an older version silently lacks anything added since —
   * and the failure is invisible, because a turn that is never detected looks
   * exactly like a turn that never came. That is what happened: a saved list
   * from before "your turn" existed meant the room's actual banner matched
   * nothing, and auto-draft sat out every pick without a word.
   *
   * Wrongly matching text is handled elsewhere, by rejecting phrases that
   * describe a future pick, so the cost of a superfluous phrase is low and
   * the cost of a missing one is a lost pick. */
  async getTurnPhrases() {
    const stored = await get(KEYS.turnPhrases, null);
    if (!stored?.length) return DEFAULT_TURN_PHRASES;
    return [...new Set([...DEFAULT_TURN_PHRASES, ...stored])];
  },
  async setTurnPhrases(phrases) {
    return set(KEYS.turnPhrases, phrases);
  },
  /* Practice mode keeps the real league config alongside the mock one rather
   * than trying to reconstruct it later — restoring has to be exact, and the
   * whole point is that forgetting is not survivable on draft day. */
  /* The player pool scraped from the league's own list, when one has been
   * imported. Null means fall back to the bundled snapshot. */
  async getPool() {
    return get(KEYS.pool, null);
  },
  async setPool(pool) {
    return set(KEYS.pool, pool);
  },

  async getQueueEnabled() {
    return get(KEYS.queueEnabled, false);
  },
  async setQueueEnabled(on) {
    return set(KEYS.queueEnabled, on);
  },

  async getPractice() {
    return get(KEYS.practice, { active: false, savedConfig: null });
  },
  async setPractice(state) {
    return set(KEYS.practice, state);
  },

  async getConfirmPhrases() {
    return get(KEYS.confirmPhrases, DEFAULT_CONFIRM_PHRASES);
  },
  async setConfirmPhrases(phrases) {
    return set(KEYS.confirmPhrases, phrases);
  },
};
