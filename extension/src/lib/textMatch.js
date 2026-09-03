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
  return found;
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
