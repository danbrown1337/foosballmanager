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
export function findBoardNames(text, boardNames) {
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
  for (const m of text.matchAll(abbrevRe)) {
    const key = `${m[1]} ${m[2]}`.toLowerCase();
    const candidates = byAbbrev.get(key);
    if (candidates && candidates.length === 1) found.add(candidates[0]);
  }
  return found;
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
export function findMyTeamNames(text, boardNames) {
  const start = text.search(/YOUR TEAM/i);
  if (start === -1) return new Set();
  let section = text.slice(start, start + 1500);
  for (const marker of ["Fantasy Manager", "PRACTICE SETTINGS", "DRAFT SCOUT"]) {
    const i = section.indexOf(marker);
    if (i > -1) section = section.slice(0, i);
  }
  return findBoardNames(section, boardNames);
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
