/*
 * Detects "it's your turn to pick" from the draft room's own rendered text —
 * same philosophy as findBoardNames() in textMatch.js: search text, not DOM
 * structure, so it survives layout/class-name changes.
 *
 * HONEST LIMIT: this environment has no access to fantasysports.yahoo.com,
 * so these default phrases are an educated guess (common wording across
 * fantasy draft rooms), not something read off the real page. Treat them as
 * a starting point — run a Yahoo mock draft with the panel open, watch the
 * log, and add whatever your league's room actually says in Settings if a
 * turn goes undetected.
 */

export const DEFAULT_TURN_PHRASES = [
  "you're on the clock",
  "you are on the clock",
  "your turn to pick",
  "your turn now",
  "it's your pick",
  "it is your pick",
  "make your pick",
  "draft time",
  "you're up",
];

function normalizeText(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** True if any configured phrase appears in the page text, case-insensitive.
 * Phrases are short sentences, not single words, so a plain substring check
 * (no word-boundary regex) is enough and avoids over-engineering this. */
export function isMyTurn(text, phrases = DEFAULT_TURN_PHRASES) {
  const normalized = normalizeText(text);
  return phrases.some((phrase) => {
    const p = phrase.trim();
    if (!p) return false;
    return normalized.includes(normalizeText(p));
  });
}
