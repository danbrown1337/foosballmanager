/*
 * Ties the engine + storage together into one "what should the UI show
 * right now" call — the same shape web.py's _snapshot() builds for the
 * Python web app, so the popup and the Python app present the same
 * information even though they're two different front ends on two
 * different platforms.
 */
import {
  loadPlayers, applyNotes, assignTiers, applyDraftState, applyByes, scarcityReport,
  makePlayer, normalizePos,
} from "../engine/board.js";
import { autoPick, topPicks, defaultOnesieFloor } from "../engine/autopilot.js";
import { Storage, MOCK_STARTERS } from "./storage.js";
import { adpUrl, parseAdpFeed } from "./consensusAdp.js";
import { gradeRoster } from "../engine/grade.js";
import { buildIndex, resolve } from "./identity.js";
import { abbrevKey } from "./textMatch.js";

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
    /* Which of those it was. A rank standing in for an ADP is indistinguishable
     * from a real one once it is in the field, and that is how a receiver
     * nobody drafts anywhere — list position 113, ADP "-" in every room —
     * came off the board looking like round-nine value and onto a roster with
     * a D beside his name. */
    adpSource: typeof p.adp === "number" ? "pool" : "rank",
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
/* How much of the room has to have been read before a player's absence from
 * its ADP column is taken as meaning the column shows a dash for him. */
/* How far apart two identically-written players must be before the worse one
 * is taken out of contention. Wide, because the cost of removing a player is
 * real and only a large gap makes the mix-up expensive. */
const INDISTINGUISHABLE_ADP_GAP = 60;

const MIN_ROOM_ADP_TO_JUDGE = 100;
const ROOM_ADP_COVERAGE = 0.5;

async function buildPlayers(adp, notes, byes) {
  const pool = await Storage.getPool();
  /* Positions the imported pool does not cover at all — the league starts no
   * kicker, so its player list has none — and which therefore have to be
   * filled from elsewhere entirely. */
  let gapPositions = new Set();
  let consensusAdded = 0;
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
    gapPositions = new Set(adp.filter((r) => !covered.has(r.pos)).map((r) => normalizePos(r.pos)));
    const gaps = adp.filter((r) => !covered.has(r.pos));
    if (gaps.length > 0) rows = [...rows, ...gaps];
  }
  const players = loadPlayers(rows);
  applyNotes(players, notes);
  /* Every number we hold for a player, kept rather than overwritten.
   *
   * The layers below used to replace each other, so the last one to write won
   * and the disagreement between them was thrown away. That disagreement is
   * information: when one board has a player 69th and another has him 117th,
   * something about his role is unsettled, and the engine should be less sure
   * of him than of a player every source agrees on. */
  for (const p of players) {
    p.adpBySource = {};
    if (p.adpSource === "pool") p.adpBySource.pool = p.adp;
  }

  /* Consensus ADP under the room's own. Order of preference, weakest first:
   * list position from the pool, then consensus ADP from outside Yahoo, then
   * whatever this actual draft room reports — that last being the number the
   * people in this room are drafting toward. */
  const consensus = await Storage.getConsensus();
  if (consensus?.players?.length) {
    /* Joined on identity, not on the display string.
     *
     * This was a plain name-to-name map, and the feed and the league list do
     * not spell players the same way: "A.J. Brown" against "AJ Brown",
     * "Travis Etienne Jr." against "Travis Etienne". Every mismatch dropped
     * that player's real ADP and left him on list position instead, which is
     * the exact input the guessed-ADP rule then has to clean up after. */
    const index = buildIndex(consensus.players);

    /* For a position the pool lacks, the feed adds players as well as
     * updating them.
     *
     * The bundled file carries eleven kickers and thirteen defences. A
     * fourteen-team mock drafts fourteen of each, and a live draft announced
     * five kickers — Smack, McPherson, Pineiro, Santos, Reichard — that the
     * board had never heard of. Filling only from the bundled file leaves the
     * engine drafting those positions half blind, and it is exactly the
     * positions the league itself does not use, so nothing else can cover
     * them. The feed knows them and prices them, which is more than the
     * bundled file can say. */
    if (gapPositions.size > 0) {
      const onBoard = buildIndex(players);
      let added = 0;
      for (const candidate of consensus.players) {
        const pos = normalizePos(candidate.pos);
        if (!gapPositions.has(pos)) continue;
        if (resolve(onBoard, candidate)) continue;
        const player = makePlayer({
          rank: candidate.rank ?? 9999,
          name: candidate.name,
          team: candidate.team,
          pos,
          adp: candidate.adp,
          adpSource: "consensus",
        });
        // The feed carries a bye week, and a position filled from here has no
        // other source for one — the pool that would normally supply it is
        // the very thing that lacks this position.
        if (candidate.bye != null) player.bye = candidate.bye;
        players.push(player);
        added++;
      }
      if (added > 0) consensusAdded = added;
    }

    for (const p of players) {
      const match = resolve(index, p);
      if (!match) continue;
      p.adp = match.adp;
      p.adpSource = "consensus";
      p.adpBySource.consensus = match.adp;
      if (p.bye == null && match.bye != null) p.bye = match.bye;
    }
  }

  /* The room's designations win over the pool's: they are what this draft is
   * showing now, and a board imported earlier may carry none at all. */
  const roomStatus = await Storage.getRoomStatus();
  if (roomStatus) {
    for (const p of players) {
      const status = roomStatus[p.name];
      if (status) p.status = status;
    }
  }

  /* Projected points, straight off the room's own column. This is what makes
   * a tier cliff measurable: how much is actually lost by taking the next
   * player at the position instead of this one. */
  const roomProjection = await Storage.getRoomProjection();
  if (roomProjection) {
    for (const p of players) {
      const value = roomProjection[p.name];
      if (typeof value === "number" && value > 0) p.proj = value;
    }
  }

  const roomAdp = await Storage.getRoomAdp();
  const roomAdpCount = roomAdp ? Object.keys(roomAdp).length : 0;
  if (roomAdp) {
    for (const p of players) {
      const value = roomAdp[p.name];
      if (typeof value === "number" && value > 0) {
        p.adp = value;
        p.adpSource = "room";
        p.adpBySource.room = value;
      }
    }
  }

  /* Players whose only "ADP" is list position, once the room has been read
   * widely enough for that to mean something.
   *
   * The league's own player list has no ADP column, and the consensus feed
   * covers about four fifths of it, so the rest carry a rank in the ADP
   * field — a receiver at list position 113 whom no room in the country
   * drafts looks exactly like round-nine value. The room does publish the
   * number, and recordRoomAdp collects it for every row a sweep passes,
   * skipping the ones printed as "-". So a player still on "rank" after the
   * room has been read broadly is a player the room shows a dash for.
   *
   * Same rule as everywhere else here: absence counts only once enough has
   * been seen. Below that bar they are not excluded, only pushed down the
   * board by the engine, which keeps them draftable in the last rounds when
   * the alternative is an empty slot. */
  if (roomAdpCount >= Math.max(MIN_ROOM_ADP_TO_JUDGE, players.length * ROOM_ADP_COVERAGE)) {
    for (const p of players) {
      if (p.adpSource === "rank") p.undrafted = true;
    }
  }

  /* Players the draft room writes identically to a much better player.
   *
   * The room shows an initial and a surname — "B. ROBINSON" — and beside it a
   * position and a team. Bijan and Brian Robinson are both Atlanta running
   * backs, so all four fields match and nothing on the page distinguishes
   * them. Every attempt to tell them apart has been a heuristic over their
   * ADPs, and the wrong one has been drafted in four separate drafts.
   *
   * So the worse one stops being draftable. He stays on the board, because a
   * rival taking him still has to be recognised, but he is never offered to
   * us. The trade is plainly worth it: a player a hundred and fifty places
   * down the board is worth less than the risk of spending an early pick on
   * him by mistake. Only a wide gap qualifies — two players genuinely close
   * in value are both acceptable picks, so a mix-up there costs nothing worth
   * protecting against. */
  const byLook = new Map();
  for (const p of players) {
    const key = `${abbrevKey(p.name) || p.name}|${p.pos}|${(p.team || "").toUpperCase()}`;
    if (!byLook.has(key)) byLook.set(key, []);
    byLook.get(key).push(p);
  }
  for (const group of byLook.values()) {
    if (group.length < 2) continue;
    const ranked = [...group].sort((a, b) => a.adp - b.adp);
    const best = ranked[0];
    for (const other of ranked.slice(1)) {
      if (other.adp - best.adp >= INDISTINGUISHABLE_ADP_GAP) other.ambiguous = true;
    }
  }

  /* How far apart the sources are for each player. Two is enough to see a
   * disagreement; the spread is what the engine acts on. */
  for (const p of players) {
    const values = Object.values(p.adpBySource).filter((v) => typeof v === "number");
    p.adpSpread = values.length > 1 ? Math.max(...values) - Math.min(...values) : 0;
  }
  if (pool?.players?.length) {
    // Injury designations come only from the imported pool; the bundled file
    // has none, and a player who cannot play must not look draftable.
    const statusByName = new Map(pool.players.map((p) => [p.name, p.status ?? null]));
    /* Strict null: a pool with no ADP column leaves this undefined, and
     * unknown is not the same as "nobody drafts him".
     *
     * And if not one player in the pool has a number, the column wasn't there
     * — so ignore the field entirely rather than filtering out the whole
     * board. A pool imported before this distinction existed stores null for
     * everyone, and would otherwise stay broken until re-imported. */
    const anyAdp = pool.players.some((p) => typeof p.adp === "number");
    const noAdp = new Set(
      anyAdp ? pool.players.filter((p) => p.adp === null).map((p) => p.name) : []
    );
    for (const p of players) {
      /* The room's designation first, and only then the pool's.
       *
       * This used to assign the pool's outright, which silently undid the
       * block above: every status read from the live room was replaced, and
       * for players the pool doesn't flag it was replaced with null. Reading
       * designations out of the room was added precisely because players who
       * could not play were being drafted, and a pool import turned the whole
       * feature off again. */
      p.status = p.status ?? statusByName.get(p.name) ?? null;
      // Either reason is sufficient, so don't let one clear the other.
      p.undrafted = p.undrafted || noAdp.has(p.name);
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

/* The turn context the room knows and the engine cannot work out for itself:
 * how many picks until this manager is up again. Only the panel can see it —
 * it depends on the draft slot and the snake — so it rides in with the
 * request rather than being stored. */
/* Players the room will not produce, set aside for recommendations only.
 *
 * A name the panel has failed to find three times is one the engine goes on
 * recommending, because the board still lists him as available — so the panel
 * fixates: the same name at every turn, unfindable every time, while the
 * player it could actually draft never gets offered. Excluding him here is
 * not the same as marking him drafted. Nothing is written to the board, the
 * exclusion lasts as long as the room keeps refusing to produce him, and if
 * he turns up again he is simply recommended again. */
function withoutExcluded(players, exclude) {
  if (!exclude?.length) return players;
  const set = new Set(exclude);
  return players.filter((p) => !set.has(p.name));
}

function withRoomContext(config, { picksUntilTurn = null, teams = null, format = null } = {}) {
  let out = config;

  /* The room's own team count and starting construction, over the configured
   * ones. These are facts about the draft being played, not preferences, and
   * they are what every rule downstream is derived from — replacement level,
   * the need gradient, the depth targets, the round kickers unlock, how many
   * picks remain. A mock starts a kicker and one flex while the league it is
   * practising for starts no kicker and two, so taking the settings on faith
   * gets all of them wrong at once.
   *
   * Applied per request rather than saved, because that same difference means
   * what a mock room says must never overwrite the real league's settings. */
  if (Number.isFinite(teams) && teams >= 2) {
    out = { ...out, league: { ...(out.league || {}), num_teams: teams } };
  }
  if (format?.starters && format.total > 0) {
    out = {
      ...out,
      roster: { ...(out.roster || {}), starters: format.starters, bench: format.bench, ir: format.ir },
    };
  }
  if (Number.isFinite(picksUntilTurn) && picksUntilTurn > 0) {
    out = { ...out, autopilot: { ...(out.autopilot || {}), picks_until_turn: picksUntilTurn } };
  }
  return out;
}

export async function buildSnapshot({ picksUntilTurn = null, teams = null, format = null, exclude = null } = {}) {
  const [{ adp, notes, byes }, config, draftState, practice] = await Promise.all([
    loadStaticData(),
    Storage.getConfig(),
    Storage.getDraftState(),
    Storage.getPractice(),
  ]);

  const players = await buildPlayers(adp, notes, byes);
  applyDraftState(players, draftState);

  const room = withRoomContext(config, { picksUntilTurn, teams, format });
  const decision = autoPick(withoutExcluded(players, exclude), room);
  const mine = players.filter((p) => p.draftedBy === "mine").sort((a, b) => a.adp - b.adp);

  return {
    board: [...players].sort((a, b) => a.adp - b.adp).map((p) => ({
      name: p.name, pos: p.pos, team: p.team, adp: p.adp, tier: p.tier, bye: p.bye,
      // Where that ADP came from, and how far the sources disagree — the two
      // things a decision record needs to explain a pick after the fact.
      adpSource: p.adpSource, adpSpread: p.adpSpread,
      status: p.status,
      draftedBy: p.draftedBy, noteTag: p.noteTag, note: p.note,
    })),
    mine: mine.map((p) => ({ name: p.name, pos: p.pos, team: p.team })),
    scarcity: scarcityReport(players, config),
    recommendation: decision && {
      name: decision.player.name, pos: decision.player.pos, team: decision.player.team,
      tier: decision.player.tier, reason: decision.reason, needOverride: decision.needOverride,
      // For the decision record: what this pick was chosen over, and by how much.
      alternatives: decision.alternatives ?? null,
      components: decision.components ?? null,
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
  await Storage.clearDraftLog();
  await Storage.clearTurnLog();
  return buildSnapshot();
}

/* One decision, written down at the moment it is made.
 *
 * Yahoo does not keep mock drafts, so a roster reviewed afterwards is all
 * anyone has had to go on — which is why every question about this engine
 * ("why three tight ends?", "why no backs?") took a conversation to answer
 * instead of a lookup. */
/* What happened at one turn, whoever ended up making the pick. */
export async function recordTurn(entry) {
  const log = await Storage.appendTurnLog({ at: new Date().toISOString(), ...entry });
  return { turns: log.length };
}

export async function recordDecision(entry) {
  const log = await Storage.appendDraftLog({
    at: new Date().toISOString(),
    ...entry,
  });
  return { logged: log.length };
}

/* The draft graded against itself: what the engine drafted, scored by the
 * same board it drafted from. */
export async function gradeDraft() {
  const [{ adp, notes, byes }, config, draftState, log] = await Promise.all([
    loadStaticData(),
    Storage.getConfig(),
    Storage.getDraftState(),
    Storage.getDraftLog(),
  ]);
  const turns = await Storage.getTurnLog();
  const players = await buildPlayers(adp, notes, byes);
  applyDraftState(players, draftState);
  /* The turns the panel lost are the story of a draft it barely took part
   * in, and they belong beside the picks it won. */
  const missed = turns.filter((t) => t.outcome !== "drafted");
  const reasons = {};
  for (const turn of missed) reasons[turn.outcome] = (reasons[turn.outcome] || 0) + 1;
  return {
    ...gradeRoster(players, config, log),
    log,
    turns,
    turnsSeen: turns.length,
    turnsWon: turns.length - missed.length,
    missedReasons: reasons,
  };
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
export async function shortlist(n = 5, {
  picksUntilTurn = null, teams = null, format = null, exclude = null, round = null,
} = {}) {
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
  /* One config for the whole function: the room's own team count and format
   * where it stated them, the settings where it did not. Everything below —
   * which slots are unfilled, how many picks remain, when a kicker unlocks —
   * has to read the same one the engine does, or the queue and the engine
   * disagree about the draft they are in. */
  const roomConfig = withRoomContext(config, { picksUntilTurn, teams, format });
  const starters = roomConfig.roster?.starters || {};
  const mine = players.filter((p) => p.draftedBy === "mine");
  const spots = Object.values(starters).reduce((a, b) => a + b, 0) + (roomConfig.roster?.bench || 0);
  const remaining = spots - mine.length;
  const unfilled = Object.keys(starters).filter(
    (pos) => pos !== "FLEX" && mine.filter((p) => p.pos === pos).length < starters[pos]
  );

  /* The queue is what Yahoo drafts from when we are not watching, so anything
   * reserved here is a pick the engine never gets to vote on. It therefore
   * has to respect the same floor the engine does: reserving a kicker in
   * round twelve hands over a pick that autoPick would have refused, and the
   * two disagreeing is worse than either rule alone. */
  /* The room's round, not our count of it.
   *
   * This derived the round from how many players the board believes are
   * drafted, and the board lags — by ninety picks in one draft. It therefore
   * thought round eight while the room was in round fourteen, so the floor
   * below never lifted, no defence was ever reserved into the queue, and the
   * slot finished the draft empty. Twice.
   *
   * The room prints the round in its banner and cannot be behind itself. */
  const picksMade = players.filter((p) => p.draftedBy).length;
  const roundNow = round ?? (Math.floor(picksMade / (roomConfig.league?.num_teams || 10)) + 1);
  const onesieFloor = roomConfig.autopilot?.onesie_min_round ?? defaultOnesieFloor(roomConfig);

  const reserved = [];
  if (unfilled.length > 0 && remaining <= unfilled.length + 3) {
    for (const pos of unfilled) {
      if ((pos === "K" || pos === "DEF") && roundNow < onesieFloor) continue;
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
  const picks = [...reserved, ...topPicks(withoutExcluded(players, exclude), roomConfig, n * 3)];
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
/* ADP observed in the draft room, merged over whatever the board was using.
 * Names arrive as the room writes them and are resolved by the caller, so
 * this stores board names only. */
/* Fetch consensus ADP and keep it. Runs in the service worker because a
 * content script cannot go cross-origin; the host permission covers only this
 * one domain. */
export async function refreshConsensusAdp() {
  const config = await Storage.getConfig();
  const url = adpUrl({
    scoring: config.league?.scoring,
    teams: config.league?.num_teams,
    year: new Date().getFullYear(),
  });
  const response = await fetch(url);
  if (!response.ok) throw new Error(`ADP feed returned ${response.status}`);
  const players = parseAdpFeed(await response.json());
  if (players.length < 100) {
    // A short feed is a failed request wearing a success, and this replaces
    // the ordering of the entire board.
    return { ok: false, count: players.length };
  }
  await Storage.setConsensus({ fetchedAt: Date.now(), url, players });
  return { ok: true, count: players.length };
}

/* Injury designations observed in the room, by board name. Kept separately
 * from the pool's, which are only as good as the last import. */
export async function recordRoomStatus(entries) {
  const existing = (await Storage.getRoomStatus()) || {};
  let changed = 0;
  for (const [name, status] of Object.entries(entries)) {
    if (!status || existing[name] === status) continue;
    existing[name] = status;
    changed++;
  }
  if (changed > 0) await Storage.setRoomStatus(existing);
  return { changed, total: Object.keys(existing).length };
}

export async function recordRoomProjection(entries) {
  const existing = (await Storage.getRoomProjection()) || {};
  let changed = 0;
  for (const [name, proj] of Object.entries(entries)) {
    if (typeof proj !== "number" || !(proj > 0)) continue;
    if (existing[name] === proj) continue;
    existing[name] = proj;
    changed++;
  }
  if (changed > 0) await Storage.setRoomProjection(existing);
  return { changed };
}

export async function recordRoomAdp(entries) {
  const existing = (await Storage.getRoomAdp()) || {};
  let changed = 0;
  for (const [name, adp] of Object.entries(entries)) {
    if (typeof adp !== "number" || !(adp > 0)) continue;
    if (existing[name] === adp) continue;
    existing[name] = adp;
    changed++;
  }
  if (changed > 0) await Storage.setRoomAdp(existing);
  return { changed, total: Object.keys(existing).length };
}

export async function repairBoard(availableNames, { markMissing = true } = {}) {
  const available = new Set(availableNames);
  const { adp, notes, byes } = await loadStaticData();
  // Same source as everywhere else: repairing against a different set of
  // names than the board is built from would mark players who don't exist.
  const players = await buildPlayers(adp, notes, byes);
  const state = await Storage.getDraftState();

  let markedDrafted = 0;
  let freed = 0;
  /* Named, not just counted. A caller that concluded a pick on its own
   * evidence needs to know when the room later contradicts it — that is the
   * only way a rule that marks players can find out it is wrong. */
  const freedNames = [];
  for (const player of players) {
    if (state.drafted[player.name] === "mine") continue;
    if (available.has(player.name)) {
      if (player.name in state.drafted) {
        delete state.drafted[player.name];
        freed++;
        freedNames.push(player.name);
      }
    } else if (markMissing && !(player.name in state.drafted)) {
      // Only when the caller says its view of the room was complete: marking
      // from absence is the one direction that can invent a pick.
      state.drafted[player.name] = "rival";
      markedDrafted++;
    }
  }
  await Storage.setDraftState(state);
  return { markedDrafted, freed, freedNames, seen: available.size };
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
