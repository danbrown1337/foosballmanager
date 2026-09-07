/*
 * Player identity across sources.
 *
 * Everything here has been joined by display name, and display names are not
 * identity. "A.J. Brown" and "AJ Brown", "Travis Etienne Jr." and "Travis
 * Etienne", "Amon-Ra St. Brown" and "Amon-Ra St.Brown" are one player each,
 * and a join on the raw string silently drops one of every pair — which shows
 * up not as an error but as a player quietly missing his ADP, and then as a
 * bad pick, because a missing ADP falls back to list position.
 *
 * The room's abbreviations are a separate problem, solved separately in
 * textMatch: no identifier helps read "B. ROBINSON" off a page. This is about
 * joining the sources we hold to each other.
 */

/* Suffixes carry no identity — sources disagree about whether to print them,
 * and two players on the same team who differ only by suffix do not exist. */
const SUFFIXES = /\b(?:jr|sr|ii|iii|iv|v)\.?$/;

/**
 * A name reduced to what is stable about it: lower case, no punctuation, no
 * suffix, single-spaced. "A.J. Brown", "AJ Brown" and "A J Brown" all become
 * "aj brown".
 */
export function normalizeName(name) {
  if (!name) return "";
  let out = String(name)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")   // strip accents, keep the letters
    .replace(/[.'’`]/g, "")        // punctuation inside names carries nothing
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  const parts = out.split(" ");
  while (parts.length > 2 && SUFFIXES.test(parts[parts.length - 1])) parts.pop();
  return parts.join(" ");
}

/* Name plus team plus position: enough to separate two players who genuinely
 * share a name, which name alone cannot.
 *
 * A defence is not a person and has no name worth normalising — every source
 * invents its own ("Seattle Defense", "Seahawks", "Seattle Seahawks", "SEA")
 * and all of them mean the team. The team is the identity, so that is the
 * key, and thirteen defences stop being unmatchable. */
export function identityKey(player) {
  const team = (player.team || "").toUpperCase();
  const pos = (player.pos || player.position || "").toUpperCase();
  if (pos === "DEF" && team) return `def|${team}|DEF`;
  return `${normalizeName(player.name)}|${team}|${pos}`;
}

/**
 * Index a list of players for lookup, most specific key first.
 *
 * Three keys per player, tried in that order by `resolve`: name with team and
 * position, name with team, then name alone. A name that would be ambiguous
 * on its own is recorded as ambiguous rather than pointing at one of the two,
 * so a caller gets nothing instead of the wrong player.
 */
export function buildIndex(players) {
  const full = new Map();
  const withTeam = new Map();
  const byName = new Map();
  const ambiguous = new Set();

  for (const p of players) {
    const name = normalizeName(p.name);
    if (!name) continue;
    full.set(identityKey(p), p);
    /* Ambiguity is between different players, and two entries sharing a
     * display name is exactly the case that matters — Brian Robinson of
     * Atlanta and Brian Robinson of Washington are one string and two people.
     * So compare full identity, not the name that is equal by construction. */
    const key = identityKey(p);
    const teamKey = `${name}|${(p.team || "").toUpperCase()}`;
    if (withTeam.has(teamKey) && identityKey(withTeam.get(teamKey)) !== key) {
      ambiguous.add(teamKey);
    }
    withTeam.set(teamKey, p);
    if (byName.has(name) && identityKey(byName.get(name)) !== key) ambiguous.add(name);
    byName.set(name, p);
  }
  return { full, withTeam, byName, ambiguous };
}

/**
 * Find the indexed player matching this one, or null.
 *
 * Never guesses between two players who share a normalized name: an
 * ambiguous match returns null, because a wrong join here is worse than a
 * missing one — it attaches another player's ADP.
 */
export function resolve(index, player) {
  const exact = index.full.get(identityKey(player));
  if (exact) return exact;

  const name = normalizeName(player.name);
  if (!name) return null;

  const teamKey = `${name}|${(player.team || "").toUpperCase()}`;
  if (index.withTeam.has(teamKey) && !index.ambiguous.has(teamKey)) {
    return index.withTeam.get(teamKey);
  }
  if (index.byName.has(name) && !index.ambiguous.has(name)) return index.byName.get(name);
  return null;
}
