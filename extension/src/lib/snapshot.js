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

/* Yahoo's own list, if it has been imported: current teams, current
 * positions, per-player byes and Yahoo's rank — against a bundled file
 * compiled before the season, which has both Robinsons on Atlanta. Rank
 * stands in for ADP: it orders the board the same way, and it is the number
 * the league itself is showing. */
function playersFromPool(pool) {
  return pool.players.map((p) => ({
    rank: p.rank,
    name: p.name,
    team: p.team,
    pos: p.pos,
    // Yahoo's own ADP where it has one; list order otherwise, which is only a
    // stand-in for ordering and says nothing about whether he gets drafted.
    adp: typeof p.adp === "number" ? p.adp : p.rank,
  }));
}

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

/* One place that decides where the board comes from, so every caller —
 * snapshot, shortlist, repair — sees the same players. */
async function buildPlayers(adp, notes, byes) {
  const pool = await Storage.getPool();
  let rows = adp;
  if (pool?.players?.length) {
    rows = playersFromPool(pool);

    /* Fill in positions the pool doesn't cover at all, from the bundled file.
     *
     * The pool comes from the user's own league, and Yahoo only lists
     * positions that league uses — this one starts no kicker, so its player
     * list contains none. Mock rooms do start one, and have no players page
     * of their own to import from, so without this a mock can never draft a
     * kicker: two finished with the slot empty for exactly that reason.
     *
     * Only whole missing positions are taken, so the pool stays authoritative
     * for everything it does cover and the stale bundled ranks don't creep
     * back in alongside it. */
    const covered = new Set(rows.map((r) => r.pos));
    const gaps = adp.filter((r) => !covered.has(r.pos));
    if (gaps.length > 0) rows = [...rows, ...gaps];
  }
  const players = loadPlayers(rows);
  applyNotes(players, notes);
  if (pool?.players?.length) {
    // Injury designations come only from the imported pool; the bundled file
    // has none, and a player who cannot play must not look draftable.
    const statusByName = new Map(pool.players.map((p) => [p.name, p.status ?? null]));
    // Strict null: a pool with no ADP column at all leaves this undefined,
    // and unknown is not the same as "nobody drafts him".
    const noAdp = new Set(pool.players.filter((p) => p.adp === null).map((p) => p.name));
    for (const p of players) {
      p.status = statusByName.get(p.name) ?? null;
      p.undrafted = noAdp.has(p.name);
    }
    // Per-player byes from the league page beat a team lookup: a player who
    // changed team mid-season is right here and wrong in a static map.
    const byeByName = new Map(pool.players.map((p) => [p.name, p.bye ?? null]));
    for (const p of players) p.bye = byeByName.get(p.name) ?? null;
  } else {
    applyByes(players, byes);
  }
  assignTiers(players);
  return players;
}

export async function buildSnapshot() {
  const [{ adp, notes, byes }, config, draftState, practice] = await Promise.all([
    loadStaticData(),
    Storage.getConfig(),
    Storage.getDraftState(),
    Storage.getPractice(),
  ]);

  const players = await buildPlayers(adp, notes, byes);
  applyDraftState(players, draftState);

  const decision = autoPick(players, config);
  const mine = players.filter((p) => p.draftedBy === "mine").sort((a, b) => a.adp - b.adp);

  return {
    board: [...players].sort((a, b) => a.adp - b.adp).map((p) => ({
      name: p.name, pos: p.pos, team: p.team, adp: p.adp, tier: p.tier, bye: p.bye,
      status: p.status,
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
  const players = await buildPlayers(adp, notes, byes);
  applyDraftState(players, draftState);

  /* At most two per position.
   *
   * The shortlist is a fallback chain — each entry answers "if he's sniped,
   * then who?" — so with one real need it correctly returns five players at
   * that position. But Yahoo drafts from this queue, and if two of your turns
   * pass before it refreshes it takes two of them. A roster arrived at three
   * tight ends that way. Two deep at a position is enough to survive a snipe;
   * beyond that it stops being insurance and starts being a plan nobody made.
   */
  /* Reserve room for starter slots that are still empty.
   *
   * Yahoo drafts from this queue whenever we aren't watching — a backgrounded
   * tab, a closed Players list, a throttled poll — and a queue with no kicker
   * in it cannot fill a kicker slot however good the engine's reasoning is.
   * A live mock ended 15/15 with K and DEF empty and four tight ends for
   * exactly this reason: the guardrail that forces those picks only affects
   * recommendations we are awake to act on.
   *
   * So once the roster is nearly full, every unfilled starting position gets
   * an entry, ahead of anything else. */
  const starters = config.roster?.starters || {};
  const mine = players.filter((p) => p.draftedBy === "mine");
  const spots = Object.values(starters).reduce((a, b) => a + b, 0) + (config.roster?.bench || 0);
  const remaining = spots - mine.length;
  const unfilled = Object.keys(starters).filter(
    (pos) => pos !== "FLEX" && mine.filter((p) => p.pos === pos).length < starters[pos]
  );

  const reserved = [];
  if (unfilled.length > 0 && remaining <= unfilled.length + 3) {
    for (const pos of unfilled) {
      const best = players
        .filter((p) => !p.draftedBy && p.pos === pos)
        .sort((a, b) => a.adp - b.adp)[0];
      if (best) {
        reserved.push({
          name: best.name, pos: best.pos, team: best.team, tier: best.tier,
          reason: `Reserved: ${pos} is still unfilled with ${remaining} pick(s) left.`,
          needOverride: true,
        });
      }
    }
  }

  const PER_POSITION = 2;
  const picks = [...reserved, ...topPicks(players, config, n * 3)];
  const counts = {};
  const out = [];
  const seenNames = new Set();
  for (const pick of picks) {
    if (seenNames.has(pick.name)) continue;
    seenNames.add(pick.name);
    counts[pick.pos] = (counts[pick.pos] || 0) + 1;
    if (counts[pick.pos] > PER_POSITION) continue;
    out.push(pick);
    if (out.length === n) break;
  }
  return out;
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
  const { adp, notes, byes } = await loadStaticData();
  // Same source as everywhere else: repairing against a different set of
  // names than the board is built from would mark players who don't exist.
  const players = await buildPlayers(adp, notes, byes);
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
