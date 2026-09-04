/*
 * DOM-agnostic page reading, ported from fantasy_manager/browser_sync.py.
 *
 * Two independent strategies, matching the Python original:
 *
 *  1. findBoardNames() — search rendered page text for the ~190 names
 *     already on the ADP board. No selectors, survives any layout change,
 *     and cannot invent a player who doesn't exist. This is what the draft
 *     room content script uses to detect picks.
 *
 *  2. parseRosterText() — extract "Name TEAM - POS" rows for pages that
 *     show a full roster (team page, league rosters). Used for reading
 *     your own team and generating sit/start suggestions.
 *
 * Both key off Yahoo's rendered text rather than CSS class names, which are
 * generated and change without notice.
 */

import { normalizePos } from "../engine/board.js";

/* Yahoo's live draft room never renders a full name. Every player in the
 * board, the pick feed and the roster is abbreviated to an initial and a
 * surname — "J. Gibbs", and in the last-pick banner "A. JEANTY" — so full-name
 * search finds nothing there at all, which is exactly how a working panel
 * ends up never detecting a single pick. Confirmed against a real Yahoo mock
 * draft room, 2026-09-03.
 *
 * Abbreviations are matched only where they're unambiguous. Two board players
 * sharing an initial and surname (J. Williams could be Jameson or Javonte)
 * resolve to nothing rather than to a guess: a missed pick leaves the board
 * one name stale, while a wrong one credits a rival with a player who is
 * still sitting there to be drafted. */
function abbrevKey(name) {
  const parts = name.trim().split(/\s+/);
  if (parts.length < 2) return null;
  const surname = parts[parts.length - 1].replace(/[.,]/g, "");
  // Drop generational suffixes so "Marvin Harrison Jr." keys off "Harrison".
  const last = /^(jr|sr|ii|iii|iv|v)$/i.test(surname) && parts.length > 2
    ? parts[parts.length - 2]
    : surname;
  return `${parts[0][0]} ${last}`.toLowerCase();
}

/** Which known player names appear in this page's text. Word-boundary
 * guards (JS regex lookaround, same as Python's) keep "Josh Allen" from
 * matching inside "Josh Allenson". */
export function findBoardNames(text, boardNames, players = null, ambiguous = null) {
  const found = new Set();
  for (const name of boardNames) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(?<!\\w)${escaped}(?!\\w)`);
    if (re.test(text)) found.add(name);
  }

  // Second pass: initial-plus-surname, as the draft room actually writes it.
  const byAbbrev = new Map();
  for (const name of boardNames) {
    const key = abbrevKey(name);
    if (!key) continue;
    if (byAbbrev.has(key)) byAbbrev.get(key).push(name);
    else byAbbrev.set(key, [name]);
  }
  // Surnames may be title case or upper case depending on where in the room
  // they appear, and apostrophes/hyphens are part of the name (Ja'Marr, Smith-Njigba).
  const abbrevRe = /(?<!\w)([A-Za-z])\.\s*([A-Za-z][A-Za-z'\u2019-]+)(?!\w)/g;
  const meta = players ? new Map(players.map((p) => [p.name, p])) : null;
  for (const m of text.matchAll(abbrevRe)) {
    const key = `${m[1]} ${m[2]}`.toLowerCase();
    const candidates = byAbbrev.get(key);
    if (!candidates) continue;
    if (candidates.length === 1) {
      found.add(candidates[0]);
      continue;
    }
    /* The room prints a position and team beside every name — "(RB \u00b7 LV)"
     * in the pick feed, "RB Det Bye 6" on the roster — which is enough to tell
     * two players with the same initial and surname apart. Without it B.
     * Robinson stays permanently unmatched, and an undetected pick means the
     * board goes on recommending a player who left the pool in round one.
     *
     * Team first: Bijan and Brian Robinson are both RBs, so position alone
     * settles nothing. Still refuses to guess when neither narrows to one. */
    if (!meta) continue;
    const context = text.slice(m.index, m.index + 60);
    const hit = (value) => value && new RegExp(`(?<!\\w)${value}(?!\\w)`, "i").test(context);
    const byTeam = candidates.filter((name) => hit(meta.get(name)?.team));
    if (byTeam.length === 1) {
      found.add(byTeam[0]);
      continue;
    }
    const byPos = candidates.filter((name) => hit(meta.get(name)?.pos));
    if (byPos.length === 1) found.add(byPos[0]);
    else if (ambiguous) ambiguous.add(`${m[1]}. ${m[2]}`);
  }
  return found;
}

/* Abbreviations on the page that match more than one board player and can't
 * be narrowed by position or team — two players genuinely listed alike, as
 * Bijan and Brian Robinson are in the current ADP file (both RB ATL).
 * Declining to guess is right, but a pick silently never recorded leaves the
 * board recommending someone already gone, which is what this surfaces so it
 * can be marked by hand. */
export function findAmbiguousAbbrevs(text, boardNames, players) {
  const ambiguous = new Set();
  findBoardNames(text, boardNames, players, ambiguous);
  return ambiguous;
}

/* What the room's own queue currently holds. Returns null when the queue
 * panel isn't on screen at all — a distinction that matters: an empty set
 * means "the room says the queue is empty", while null means "we can't see
 * it", and only the first is evidence a queued player was drafted. */
export function findQueueNames(text, boardNames, players = null) {
  const start = text.search(/Autodraft will pick from queue/i);
  if (start === -1) return null;
  let section = text.slice(start, start + 1200);
  const end = section.search(/(?<!\w)(Players|Board|Results|Standings)(?!\w)/);
  if (end > -1) section = section.slice(0, end);
  if (/your queue is empty/i.test(section)) return new Set();
  return findBoardNames(section, boardNames, players);
}

/* The page text with the queue panel cut out.
 *
 * Queueing a player writes his name into that panel, and the pick detector
 * reads the page — so a name appearing there was being recorded as drafted.
 * The extension queueing someone therefore marked him gone the moment it
 * succeeded, removing him from its own shortlist and corrupting the board.
 * Confirmed live: starring J. Tyson produced "Detected: Jordyn Tyson" on the
 * next poll. */
export function withoutQueuePanel(text) {
  const start = text.search(/Autodraft will pick from queue/i);
  if (start === -1) return text;
  const rest = text.slice(start);
  const end = rest.search(/(?<!\w)(Players|Board|Results|Standings)(?!\w)/);
  return end === -1 ? text.slice(0, start) : text.slice(0, start) + rest.slice(end);
}

/* Where you pick, and where the draft has got to.
 *
 * The room states both: the URL ends in your slot, the title says "You pick
 * 11th", and the status bar carries "Round 4, Pick 50". Between them the
 * panel can say when your next pick actually lands, rather than counting
 * roster spots and hoping. */
export function parseDraftSlot(url, title) {
  const fromUrl = /\/draftclient\/f1\/\d+\/(\d+)/.exec(url || "");
  if (fromUrl) return Number(fromUrl[1]);
  const fromTitle = /you pick (\d+)(?:st|nd|rd|th)/i.exec(title || "");
  return fromTitle ? Number(fromTitle[1]) : null;
}

export function parseDraftPosition(text) {
  const m = /round\s+(\d+),\s*pick\s+(\d+)/i.exec(text || "");
  return m ? { round: Number(m[1]), pick: Number(m[2]) } : null;
}

/* What the team count can be, given the draft is at this round and pick.
 * Pick p in round r means (r-1)*T < p <= r*T, so T is bounded either side.
 * Used to check the configured count against the room the user is actually
 * in: a 10-team config in a 14-team room makes every pick calculation wrong,
 * and nothing else would notice. */
export function teamCountBounds(position) {
  if (!position || position.round < 1) return null;
  const min = Math.ceil(position.pick / position.round);
  const max = position.round > 1
    ? Math.floor((position.pick - 1) / (position.round - 1))
    : Infinity;
  return { min, max };
}

/* Snake order: odd rounds run 1..N, even rounds run N..1. Counted the way the
 * room counts it — inclusive of the pick in progress — so the panel and
 * Yahoo's own "N picks until your turn" agree. */
export function picksUntilMyTurn(position, slot, teams) {
  if (!position || !slot || !teams) return null;
  const overall = position.pick;
  for (let round = position.round; round <= position.round + 2; round++) {
    const mineThisRound = round % 2 === 1
      ? (round - 1) * teams + slot
      : (round - 1) * teams + (teams - slot + 1);
    if (mineThisRound >= overall) return mineThisRound - overall + 1;
  }
  return null;
}

/* Which roster slots the room itself shows, read off the YOUR TEAM panel:
 * the labels are the league's actual starter construction. Used to catch the
 * case that silently cost a kicker in testing — a room that starts a K while
 * the configured league has none, where the engine treats every kicker as
 * unrostable and the unfilled-starter guardrail reads the same config and so
 * never warns either. */
/* How many players this room drafts, from its own header: "YOUR TEAM (3/15)".
 * The total is the one number in the roster panel that needs no parsing of
 * slot labels interleaved with player rows, and it is enough to catch a
 * league config that doesn't describe this room. */
export function findRosterTotal(text) {
  const m = /YOUR TEAM\s*\((\d+)\s*\/\s*(\d+)\)/i.exec(text);
  return m ? { filled: Number(m[1]), total: Number(m[2]) } : null;
}

export function findRosterSlots(text) {
  const start = text.search(/YOUR TEAM/i);
  if (start === -1) return new Set();
  const section = text.slice(start, start + 1500);
  const slots = new Set();
  for (const line of section.split("\n")) {
    const label = line.trim().toUpperCase();
    if (["QB", "RB", "WR", "TE", "K", "DEF", "BN", "IR"].includes(label)) slots.add(label);
  }
  return slots;
}

/* The draft room states your roster outright, in a panel headed "YOUR TEAM
 * (5/15)". Reading that is not the same as inferring your picks from what
 * changed on the page — the thing this project refuses to do, because a diff
 * can credit your own pick to a rival. This is the room telling us, in its
 * own words, which players are yours.
 *
 * The window is bounded and known overlay text is stripped: our own panel
 * prints the recommended player's FULL name, and matching that inside this
 * slice would mark a player you don't own as yours. */
export function findMyTeamNames(text, boardNames, players = null) {
  const start = text.search(/YOUR TEAM/i);
  if (start === -1) return new Set();
  let section = text.slice(start, start + 1500);
  for (const marker of ["Fantasy Manager", "PRACTICE SETTINGS", "DRAFT SCOUT"]) {
    const i = section.indexOf(marker);
    if (i > -1) section = section.slice(0, i);
  }
  return findBoardNames(section, boardNames, players);
}

/** Newly drafted players between two polls.
 *   appear    — a picks feed or draft-results page: names show up as taken.
 *   disappear — an available-player pool: names leave it as they're taken.
 */
export function diffDrafted(previous, current, mode) {
  const out = new Set();
  if (mode === "disappear") {
    for (const name of previous) if (!current.has(name)) out.add(name);
  } else {
    for (const name of current) if (!previous.has(name)) out.add(name);
  }
  return out;
}

// "Jahmyr Gibbs Det - RB", "Seattle Seahawks Sea - DEF", "Taysom Hill NO - TE,QB"
const PLAYER_LINE = /^(.{2,40}?)\s+([A-Za-z]{2,3})\s*-\s*([A-Za-z]{1,3}(?:\s*,\s*[A-Za-z]{1,3})*)\b/;

// Yahoo appends injury/status designations after the position.
const STATUS_SUFFIXES = new Set(["Q", "D", "O", "IR", "SUSP", "PUP", "NA", "GTD"]);
const SLOT_LABELS = new Set(["QB", "RB", "WR", "TE", "K", "DEF", "BN", "IR", "W/R/T", "FLEX"]);

export function normalizePosition(raw) {
  const first = raw.split(",")[0].trim().toUpperCase();
  return normalizePos(first);
}

export function looksLikeAPlayer(name) {
  name = name.trim();
  if (name.length < 3 || !/[A-Za-z]/.test(name)) return false;
  if (/\d/.test(name)) return false;
  if (SLOT_LABELS.has(name.toUpperCase())) return false;
  return true;
}

/** Extract player rows from rendered league/roster page text. */
export function parseRosterText(text) {
  const rows = [];
  const seen = new Set();

  for (let line of text.split("\n")) {
    line = line.trim();
    if (!line) continue;
    const match = PLAYER_LINE.exec(line);
    if (!match) continue;

    // Periods are deliberately NOT stripped: the ADP board carries them in
    // "Marvin Harrison Jr.", "A.J. Brown", "Amon-Ra St. Brown", and an exact
    // name match is what attaches a player's value.
    let name = match[1].replace(/^[ ,\-–—]+|[ ,\-–—]+$/g, "");

    // A roster-slot label can precede the name on the same line ("BN Puka
    // Nacua LAR - WR"); drop it rather than folding it into the name.
    // Matches Python's str.split(None, 1): split on the first run of
    // whitespace only, keeping the remainder ("Puka Nacua") intact.
    const headMatch = /^(\S+)\s+(.*)$/s.exec(name);
    if (headMatch) {
      const [, head, rest] = headMatch;
      if (!looksLikeAPlayer(head) && SLOT_LABELS.has(head.toUpperCase())) {
        name = rest;
      }
    }

    if (!looksLikeAPlayer(name) || seen.has(name)) continue;

    const pos = normalizePosition(match[3]);
    if (STATUS_SUFFIXES.has(pos) && pos !== "K" && pos !== "D") continue;

    seen.add(name);
    rows.push({ name, pos, team: match[2].toUpperCase() });
  }

  return rows;
}

/** Split a multi-team page into { teamName: [players] }. Team headings are
 * lines that carry no player match and read like a name; players following
 * one belong to it. A page with no headings comes back under a single ""
 * key, which the caller can name explicitly. */
export function parseLeaguePage(text) {
  const teams = {};
  let current = "";
  for (const line of text.split("\n")) {
    const stripped = line.trim();
    if (!stripped) continue;
    const players = parseRosterText(stripped);
    if (players.length > 0) {
      (teams[current] ||= []).push(...players);
    } else if (stripped.length >= 3 && stripped.length <= 40 && !/\d/.test(stripped)) {
      current = stripped;
    }
  }
  return teams;
}
