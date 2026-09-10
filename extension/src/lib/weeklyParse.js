/*
 * Read a Yahoo My Team page — a port of parse_weekly_text from
 * fantasy_manager/browser_sync.py.
 *
 * WHY TEXT AND NOT SELECTORS: Yahoo's fantasy pages ship generated class names
 * that change without notice, and the draft side of this extension already
 * learned that the hard way — every DOM lookup in domActions.js matches on
 * rendered text for the same reason. The "Chi - QB" rendering has held still
 * for years. It also means this module's input is exactly what
 * document.body.innerText returns, so the page captures in tests/fixtures/
 * double as its test fixtures.
 *
 * TWO LAYOUTS. The My Team page stacks one roster row across several lines and
 * never puts the name on the same line as the position:
 *
 *     QB                             <- roster slot
 *     Caleb Williams                 <- name, clean
 *     Caleb WilliamsPlayer Note      <- name with status + note chrome run on
 *     Chi - QB                       <- team and position, alone
 *     Sun 1:00 pm @ Car              <- kickoff and opponent
 *     10                             <- bye week
 *     -                              <- Fan Pts ("-" until a game is played)
 *     18.35                          <- Proj Pts
 *     81%                            <- % started
 *
 * The league-rosters and draft-room pages do render "Jahmyr Gibbs Det - RB" on
 * one line, so that shape is handled too, as a fallback.
 *
 * compare_weekly_parse_with_python.js diffs this against the Python parser over
 * the same bytes. The Python original returned zero players off a live page
 * while passing every hand-written test, which is why the real page is the test.
 */

const POS_ALIASES = { PK: "K", DST: "DEF", "D/ST": "DEF" };

const SLOT_LABELS = new Set(["QB", "RB", "WR", "TE", "K", "DEF", "BN", "BE", "IR",
  "IR-R", "W/R/T", "FLEX", "WRT", "Q/W/R/T", "OP", "NA"]);

const STATUS_SUFFIXES = new Set(["Q", "D", "O", "IR", "SUSP", "PUP", "NA", "GTD"]);

const POS = "QB|RB|WR|TE|K|PK|DEF|DST|D/ST";

// Yahoo lists every position a player is eligible at ("NO - TE,QB"). Requiring
// a single one made the row fail to match at all, which dropped the player from
// the roster rather than merely mislabelling him.
const TEAM_POS_LINE = new RegExp(
  `^(?<team>[A-Za-z]{2,3})\\s*-\\s*(?<pos>(?:${POS})(?:\\s*,\\s*(?:${POS}))*)$`, "i");

// "Jahmyr Gibbs Det - RB" — the inline shape.
const PLAYER_LINE = /^(?<name>.{2,40}?)\s+(?<team>[A-Za-z]{2,3})\s*-\s*(?<pos>[A-Za-z]{1,3}(?:\s*,\s*[A-Za-z]{1,3})*)\b/;

// A status letter is glued to the end of the name with no separator
// ("Jeremiyah LoveQVideo Forecast"), so it is recognised by being followed by an
// uppercase letter or the end of the line. That distinguishes a real "Q" from
// the "P" of "Player Note" and the "N" of "No new player Notes", which are note
// chrome rather than a designation.
const STATUS_AFTER_NAME = /^(SUSP|PUP|GTD|IR|NA|Q|D|O|P)(?=[A-Z]|$)/;

const STATUS_AFTER_POS = /-\s*[A-Za-z]{1,3}(?:\s*,\s*[A-Za-z]{1,3})*\s+(?<status>Q|D|O|IR(?:-R)?|SUSP|PUP|NA|GTD|P)\b/;

// No \b before the alternation: a word boundary needs a word character on one
// side, and " @" is two non-word characters, so \b@ never matches at all. The
// lookbehind does the real job — keeping "vs" from firing inside a word.
const OPPONENT = /(?<![A-Za-z0-9])(?<side>@|vs\.?)\s*(?<team>[A-Za-z]{2,3})\b/i;
const BYE_MARKER = /^bye$/i;

// A projection: a decimal, plausibly scoring-sized. The decimal point is
// required — it separates a projection from the jersey numbers, week numbers
// and rostered percentages sharing the row.
const PROJECTION_FULL = /^(?<value>\d{1,2}\.\d{1,2})$/;
const PROJECTION_ANY = /(?<![\d.])(?<value>\d{1,2}\.\d{1,2})(?![\d.])/;
const BARE_INT = /^\d{1,2}$/;

export function normalizePosition(raw) {
  // Yahoo lists every eligible position ("TE,QB"); downstream code matches a
  // single one, so keep the first — the same rule the API client applies.
  const first = String(raw).split(",")[0].trim().toUpperCase();
  return POS_ALIASES[first] || first;
}

export function looksLikeAPlayer(name) {
  const trimmed = String(name).trim();
  if (trimmed.length < 3 || !/[A-Za-z]/.test(trimmed)) return false;
  if (/\d/.test(trimmed)) return false;
  if (SLOT_LABELS.has(trimmed.toUpperCase())) return false;
  return true;
}

function stripEdges(value) {
  return value.replace(/^[\s,\-–—]+|[\s,\-–—]+$/g, "");
}

/** The My Team layout: one roster row spread over consecutive lines. */
function parseStackedMyTeam(lines) {
  const rows = [];
  const seen = new Set();
  const anchors = [];
  lines.forEach((line, index) => {
    if (TEAM_POS_LINE.test(line.trim())) anchors.push(index);
  });

  anchors.forEach((index, order) => {
    const match = TEAM_POS_LINE.exec(lines[index].trim());
    const pos = normalizePosition(match.groups.pos);

    // The name sits two lines up, with the chrome-laden copy directly above the
    // anchor. Preferring the clean line keeps "Kyle Pitts Sr." intact instead of
    // "Kyle Pitts Sr.No new player Notes".
    let name = "";
    let extras = "";
    if (index >= 2) {
      const candidate = lines[index - 2].trim();
      const adorned = lines[index - 1].trim();
      if (candidate && adorned.startsWith(candidate)) {
        name = candidate;
        extras = adorned.slice(candidate.length);
      } else if (candidate) {
        name = candidate;
      }
    }
    if (!name || !looksLikeAPlayer(name) || seen.has(name)) return;
    seen.add(name);

    let slot = null;
    for (let back = 3; back < 5; back += 1) {
      if (index - back < 0) break;
      const label = lines[index - back].trim().toUpperCase();
      if (SLOT_LABELS.has(label)) { slot = label; break; }
    }

    const statusMatch = STATUS_AFTER_NAME.exec(extras);
    const status = statusMatch ? statusMatch[1].toUpperCase() : "";

    const end = order + 1 < anchors.length ? anchors[order + 1] - 3 : lines.length;
    const forward = lines.slice(index + 1, Math.max(index + 1, end)).map((l) => l.trim());

    let opponent = null;
    let byeWeek = null;
    let proj = null;
    let onBye = false;
    for (const line of forward) {
      if (line.includes("%")) {
        // Columns run Bye, Fan Pts, Proj Pts, then percentages. Stopping at the
        // first percentage and keeping the LAST decimal before it is what picks
        // Proj Pts rather than Fan Pts — which is "-" in week 1 but a real
        // number from week 2 on, and would otherwise silently become the
        // projection for the rest of the season.
        break;
      }
      if (opponent === null) {
        const found = OPPONENT.exec(line);
        if (found) {
          opponent = (found.groups.side.startsWith("@") ? "@" : "vs ")
            + found.groups.team.toUpperCase();
          continue;
        }
      }
      if (BYE_MARKER.test(line)) { onBye = true; continue; }
      if (byeWeek === null && BARE_INT.test(line)) { byeWeek = Number.parseInt(line, 10); continue; }
      const number = PROJECTION_FULL.exec(line);
      if (number) proj = Number.parseFloat(number.groups.value);
    }

    rows.push({
      name, pos, team: match.groups.team.toUpperCase(),
      slot, status, opponent, proj, bye: onBye, byeWeek,
    });
  });
  return rows;
}

/** Split an inline page into one block per player: the row plus everything up
 * to the next row. Segmenting first is what keeps a row's opponent and
 * projection its own — search a fixed window instead and every player inherits
 * his neighbour's numbers, silently and plausibly. */
function inlineBlocks(lines) {
  const anchors = [];
  lines.forEach((line, index) => {
    const match = PLAYER_LINE.exec(line.trim());
    if (match) anchors.push({ index, match });
  });
  return anchors.map(({ index, match }, order) => {
    const end = order + 1 < anchors.length ? anchors[order + 1].index : lines.length;
    const ownLine = lines[index].trim();
    const tail = [ownLine.slice(match[0].length), ...lines.slice(index + 1, end)].join("\n");
    return { index, match, tail };
  });
}

function parseInline(lines) {
  const rows = [];
  const seen = new Set();

  for (const { index, match, tail } of inlineBlocks(lines)) {
    const line = lines[index].trim();

    // Periods are deliberately NOT stripped: the ADP board carries them in
    // "A.J. Brown" and "Amon-Ra St. Brown", and an exact name match is what
    // attaches a player's value.
    let name = stripEdges(match.groups.name);
    const parts = name.split(/\s+/);
    if (parts.length > 1 && SLOT_LABELS.has(parts[0].toUpperCase())) {
      name = parts.slice(1).join(" ");
    }
    if (!looksLikeAPlayer(name) || seen.has(name)) continue;

    const pos = normalizePosition(match.groups.pos);
    if (STATUS_SUFFIXES.has(pos) && pos !== "K" && pos !== "D") continue;
    seen.add(name);

    const statusMatch = STATUS_AFTER_POS.exec(line);
    const opponentMatch = OPPONENT.exec(tail);
    const projectionMatch = PROJECTION_ANY.exec(tail);

    rows.push({
      name,
      pos,
      team: match.groups.team.toUpperCase(),
      slot: null,
      status: statusMatch ? statusMatch.groups.status.toUpperCase() : "",
      opponent: opponentMatch
        ? (opponentMatch.groups.side.startsWith("@") ? "@" : "vs ")
          + opponentMatch.groups.team.toUpperCase()
        : null,
      proj: projectionMatch ? Number.parseFloat(projectionMatch.groups.value) : null,
      bye: /\bbye\b/i.test(tail) && !opponentMatch,
      byeWeek: null,
    });
  }

  // The inline path carries no slot column, so recover the label where it leads
  // the row ("BN Puka Nacua LAR - WR").
  return rows.map((row, i) => {
    const source = lines.find((l) => l.includes(row.name));
    if (!source) return row;
    const lead = source.trim().split(/\s+/)[0].toUpperCase();
    return SLOT_LABELS.has(lead) ? { ...row, slot: lead } : row;
  });
}

/**
 * Parse a rendered Yahoo page into weekly roster rows.
 *
 * The stacked My Team shape is tried first because that is the page this is
 * for; the inline parser is the fallback for league-rosters and draft-room
 * pages, which really do put a name and position on one line.
 */
export function parseWeeklyText(text) {
  const lines = String(text).split(/\r?\n/);
  const stacked = parseStackedMyTeam(lines);
  if (stacked.length) return stacked;
  return parseInline(lines);
}
