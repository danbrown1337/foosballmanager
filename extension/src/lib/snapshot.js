/*
 * Ties the engine + storage together into one "what should the UI show
 * right now" call — the same shape web.py's _snapshot() builds for the
 * Python web app, so the popup and the Python app present the same
 * information even though they're two different front ends on two
 * different platforms.
 */
import { loadPlayers, applyNotes, assignTiers, applyDraftState, applyByes, scarcityReport } from "../engine/board.js";
import { autoPick, topPicks } from "../engine/autopilot.js";
import { Storage, MOCK_STARTERS } from "./storage.js";

let cachedAdp = null;
let cachedNotes = null;
let cachedByes = null;

async function loadStaticData() {
  if (cachedAdp && cachedNotes && cachedByes) return { adp: cachedAdp, notes: cachedNotes, byes: cachedByes };
  const [adpRes, notesRes, byeRes] = await Promise.all([
    fetch(chrome.runtime.getURL("data/adp_2026_ppr.json")),
    fetch(chrome.runtime.getURL("data/player_notes_2026.json")),
    fetch(chrome.runtime.getURL("data/bye_weeks.json")),
  ]);
  cachedAdp = await adpRes.json();
  cachedNotes = await notesRes.json();
  cachedByes = await byeRes.json();
  return { adp: cachedAdp, notes: cachedNotes, byes: cachedByes };
}

export async function buildSnapshot() {
  const [{ adp, notes, byes }, config, draftState, practice] = await Promise.all([
    loadStaticData(),
    Storage.getConfig(),
    Storage.getDraftState(),
    Storage.getPractice(),
  ]);

  const players = loadPlayers(adp);
  applyNotes(players, notes);
  applyByes(players, byes);
  assignTiers(players);
  applyDraftState(players, draftState);

  const decision = autoPick(players, config);
  const mine = players.filter((p) => p.draftedBy === "mine").sort((a, b) => a.adp - b.adp);

  return {
    board: [...players].sort((a, b) => a.adp - b.adp).map((p) => ({
      name: p.name, pos: p.pos, team: p.team, adp: p.adp, tier: p.tier, bye: p.bye,
      draftedBy: p.draftedBy, noteTag: p.noteTag, note: p.note,
    })),
    mine: mine.map((p) => ({ name: p.name, pos: p.pos, team: p.team })),
    scarcity: scarcityReport(players, config),
    recommendation: decision && {
      name: decision.player.name, pos: decision.player.pos, team: decision.player.team,
      tier: decision.player.tier, reason: decision.reason, needOverride: decision.needOverride,
    },
    // Surfaced so every front end can say, unmissably, that the settings
    // driving these recommendations are mock settings and not the league's.
    practice: !!practice.active,
    draftedCount: players.filter((p) => p.draftedBy).length,
    total: players.length,
    config,
  };
}

function resolvePlayer(players, name) {
  const exact = players.find((p) => p.name.toLowerCase() === name.toLowerCase());
  if (exact) return exact;
  // Simple fuzzy fallback: closest by shared-prefix length. Good enough for
  // the popup's search box; draft-room autodetection matches names exactly
  // via findBoardNames and never needs this path.
  const lower = name.toLowerCase();
  let best = null;
  let bestScore = 0;
  for (const p of players) {
    const pLower = p.name.toLowerCase();
    let score = 0;
    while (score < lower.length && score < pLower.length && lower[score] === pLower[score]) score++;
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }
  return bestScore >= 3 ? best : null;
}

export async function markPick(name, by) {
  const { adp, notes } = await loadStaticData();
  const players = loadPlayers(adp);
  applyNotes(players, notes);

  const player = resolvePlayer(players, name);
  if (!player) throw new Error(`No player matching "${name}".`);
  if (by !== "mine" && by !== "rival") throw new Error("Pick must be 'mine' or 'rival'.");

  const state = await Storage.getDraftState();
  if (player.name in state.drafted) throw new Error(`${player.name} is already marked drafted.`);
  state.drafted[player.name] = by;
  await Storage.setDraftState(state);
  return buildSnapshot();
}

export async function undoPick(name) {
  const state = await Storage.getDraftState();
  if (name in state.drafted) {
    delete state.drafted[name];
    await Storage.setDraftState(state);
  }
  return buildSnapshot();
}

export async function autopickCommit(commit) {
  const { adp, notes } = await loadStaticData();
  const players = loadPlayers(adp);
  applyNotes(players, notes);
  assignTiers(players);
  const config = await Storage.getConfig();
  const draftState = await Storage.getDraftState();
  applyDraftState(players, draftState);

  const decision = autoPick(players, config);
  if (!decision) throw new Error("No players left available.");
  if (commit) {
    draftState.drafted[decision.player.name] = "mine";
    await Storage.setDraftState(draftState);
  }
  return buildSnapshot();
}

export async function resetDraft() {
  await Storage.resetDraftState();
  return buildSnapshot();
}

/** Record newly-detected picks from a content script poll, defaulting to
 * "rival" — the user's own picks are always marked deliberately, in the
 * popup or via autopickCommit, never inferred from what disappeared off a
 * page (that would misattribute your own pick to a rival). */
/* Bulk import from what the page already shows, for the case detection alone
 * can never cover: a panel opened (or reloaded) mid-draft has no idea about
 * the picks made before it started watching, and only ever sees changes from
 * that moment on. Left unfixed it recommends players who went in round one.
 *
 * "mine" outranks an existing "rival": a name found in the room's own YOUR
 * TEAM panel is authoritative, and may well have been recorded as a rival's
 * earlier when it first appeared somewhere on the page. The reverse is never
 * applied — nothing here can take a player off your roster. */
/* Practice mode lives here rather than in the options page so the panel can
 * offer it too: the moment you find out the room starts a kicker your league
 * doesn't is while you're sitting in that room, not in a settings tab. */
export async function setPracticeMode(active) {
  const practice = await Storage.getPractice();
  if (active && !practice.active) {
    const config = await Storage.getConfig();
    await Storage.setPractice({ active: true, savedConfig: config });
    await Storage.setConfig({
      ...config,
      roster: { ...config.roster, starters: { ...MOCK_STARTERS } },
    });
  } else if (!active && practice.active) {
    // Restore verbatim; the stored copy is the only certainly-correct one.
    if (practice.savedConfig) await Storage.setConfig(practice.savedConfig);
    await Storage.setPractice({ active: false, savedConfig: null });
  }
  return buildSnapshot();
}

/* The shortlist the draft room's queue should hold. Built from the same live
 * state as buildSnapshot, so it reflects every pick recorded so far. */
export async function shortlist(n = 5) {
  const [{ adp, notes, byes }, config, draftState] = await Promise.all([
    loadStaticData(),
    Storage.getConfig(),
    Storage.getDraftState(),
  ]);
  const players = loadPlayers(adp);
  applyNotes(players, notes);
  applyByes(players, byes);
  assignTiers(players);
  applyDraftState(players, draftState);
  return topPicks(players, config, n);
}

/* Rebuild the drafted list from what the room still offers.
 *
 * Everything else here infers picks — watching names appear or vanish,
 * searching for a player and concluding from silence. This reads Yahoo's own
 * answer to the only question that matters: who is still available. Anything
 * on our board that Yahoo no longer lists has been drafted, and — the part
 * that repairs rather than accumulates — anything Yahoo still lists is
 * available, whatever we previously recorded.
 *
 * Your own picks are never touched: they're the one thing the available list
 * cannot tell us, since a player you drafted is missing from it for the same
 * reason a rival's pick is.
 */
export async function repairBoard(availableNames) {
  const available = new Set(availableNames);
  const { adp } = await loadStaticData();
  const players = loadPlayers(adp);
  const state = await Storage.getDraftState();

  let markedDrafted = 0;
  let freed = 0;
  for (const player of players) {
    if (state.drafted[player.name] === "mine") continue;
    if (available.has(player.name)) {
      if (player.name in state.drafted) {
        delete state.drafted[player.name];
        freed++;
      }
    } else if (!(player.name in state.drafted)) {
      state.drafted[player.name] = "rival";
      markedDrafted++;
    }
  }
  await Storage.setDraftState(state);
  return { markedDrafted, freed, seen: available.size };
}

export async function importPicks(names, by = "rival") {
  if (by !== "mine" && by !== "rival") throw new Error("Pick must be 'mine' or 'rival'.");
  const state = await Storage.getDraftState();
  let changed = false;
  for (const name of names) {
    const current = state.drafted[name];
    if (current === undefined || (by === "mine" && current === "rival")) {
      state.drafted[name] = by;
      changed = true;
    }
  }
  if (changed) await Storage.setDraftState(state);
  return { changed, count: names.length };
}

export async function recordDetectedPicks(names, by = "rival") {
  const state = await Storage.getDraftState();
  let changed = false;
  for (const name of names) {
    if (!(name in state.drafted)) {
      state.drafted[name] = by;
      changed = true;
    }
  }
  if (changed) await Storage.setDraftState(state);
  return changed;
}
