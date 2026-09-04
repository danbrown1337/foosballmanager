/*
 * Finds clickable elements on the live draft-room page by their visible
 * text — the same "search text, not structure" philosophy as
 * findBoardNames() in textMatch.js, extended from reading to (optionally)
 * clicking.
 *
 * HONEST LIMIT: this environment has no access to fantasysports.yahoo.com,
 * so these functions were built and verified against a synthetic page
 * (test/domActions.check.js) modeled on common draft-room patterns
 * (player rows as buttons/links/clickable divs, a confirm dialog with a
 * labeled button) — not against Yahoo's real DOM, which nobody on this
 * project has been able to inspect from here. Test against a real Yahoo
 * mock draft before trusting the "fully automatic" mode.
 *
 * Every function here takes its search root as a parameter instead of
 * reaching for the global `document`, so it can be exercised against any
 * DOM — a real page in a browser test, or a synthetic fixture.
 */

const CLICKABLE_SELECTOR = 'button, a, [role="button"], input[type="submit"], [onclick]';

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// The extension's own floating panel repeats the recommended player's name
// and has a button whose label contains "draft" — both would otherwise
// match our own search targets meant for Yahoo's page.
function isInsideOwnOverlay(el) {
  return !!el.closest?.("#fantasy-manager-overlay");
}

function normalizeText(text) {
  return (text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Find the best element to click to select `playerName` on the page.
 * Walks up from the matching text node looking for the nearest ancestor
 * that looks interactive (button/link/role=button/onclick); falls back to
 * the text node's immediate parent element if nothing more specific is
 * found within `maxAncestorDepth`, since many draft rooms attach a click
 * handler directly to a row div rather than using a real <button>. */
/* "Jahmyr Gibbs" never appears in a Yahoo draft room — every name there is
 * "J. Gibbs", or "J. GIBBS" in the pick feed. Searching only for the full
 * name is why auto-draft could detect a turn, hold a correct recommendation,
 * and still never click anything: the element it was looking for did not
 * exist on the page. */
function abbrevForms(name) {
  const parts = name.trim().split(/\s+/);
  if (parts.length < 2) return [];
  const tail = parts[parts.length - 1].replace(/[.,]/g, "");
  const last = /^(jr|sr|ii|iii|iv|v)$/i.test(tail) && parts.length > 2
    ? parts[parts.length - 2]
    : tail;
  return [`${parts[0][0]}. ${last}`, `${parts[0][0]}.${last}`];
}

export function findPlayerClickTarget(root, playerName, { maxAncestorDepth = 6, player = null } = {}) {
  const doc = root.ownerDocument || root;
  const re = new RegExp(`(?<!\\w)${escapeRegExp(playerName)}(?!\\w)`);
  const abbrevRes = abbrevForms(playerName).map(
    (form) => new RegExp(`(?<!\\w)${escapeRegExp(form)}(?!\\w)`, "i")
  );

  /* An abbreviation can name more than one player, and clicking the wrong row
   * drafts the wrong player — irreversible, unlike a missed detection. So an
   * abbreviated match is only accepted when the surrounding row also shows
   * this player's team or position. */
  const confirmedByContext = (node, form) => {
    if (!player) return true;
    // Team, not position: two players sharing an abbreviation usually share a
    // position too (Bijan and Brian Robinson are both RBs), so accepting a
    // position match would happily click either row. Position is only used
    // when no team is known at all.
    const required = player.team || player.pos;
    if (!required) return true;
    const re = new RegExp(`(?<!\\w)${escapeRegExp(required)}(?!\\w)`, "i");
    const reForm = new RegExp(`(?<!\\w)${escapeRegExp(form)}(?!\\w)`, "ig");
    let el = node.parentElement;
    for (let d = 0; el && d < maxAncestorDepth; d++, el = el.parentElement) {
      const text = el.textContent || "";
      if (text.length > 300) break;
      /* Stop before an ancestor holding a second player with this same
       * abbreviation: its text is the list, not this row, and a neighbouring
       * row's team would otherwise "confirm" the wrong player. */
      if ((text.match(reForm) || []).length > 1) break;
      if (re.test(text)) return true;
    }
    return false;
  };

  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue) return NodeFilter.FILTER_SKIP;
      if (isInsideOwnOverlay(node.parentElement)) return NodeFilter.FILTER_SKIP;
      if (re.test(node.nodeValue)) return NodeFilter.FILTER_ACCEPT;
      const forms = abbrevForms(playerName);
      const matched = forms.find((form, i) => abbrevRes[i].test(node.nodeValue));
      if (matched && confirmedByContext(node, matched)) return NodeFilter.FILTER_ACCEPT;
      return NodeFilter.FILTER_SKIP;
    },
  });

  const textNode = walker.nextNode();
  if (!textNode) return null;

  let el = textNode.parentElement;
  let fallback = el;
  for (let depth = 0; el && depth < maxAncestorDepth; depth++, el = el.parentElement) {
    if (el.matches?.(CLICKABLE_SELECTOR)) return el;
  }
  return fallback;
}

/** Find a "confirm/submit" style button near the top of the page — used
 * after selecting a player, when a draft room shows a confirmation step.
 * Matches short, exact-ish button text against configured phrases rather
 * than a substring search, since "draft" as a substring would also match
 * unrelated page chrome ("Mock Draft Lobby", nav links, etc). */
export function findConfirmClickTarget(root, phrases) {
  const candidates = root.querySelectorAll(CLICKABLE_SELECTOR);
  const wanted = (phrases || [])
    .map((p) => normalizeText(p))
    .filter(Boolean);
  const normalizedDefaults = DEFAULT_CONFIRM_PHRASES.map(normalizeText);
  const useDefaults = wanted.length === 0;
  const wantedSet = new Set(useDefaults ? normalizedDefaults : wanted);

  for (const el of candidates) {
    if (isInsideOwnOverlay(el)) continue;
    const text = normalizeText(el.textContent || "");
    if (!text || text.length > 40) continue;
    if (wantedSet.has(text)) return el;
  }
  return null;
}

export const DEFAULT_CONFIRM_PHRASES = ["draft", "confirm pick", "confirm", "submit pick"];

/** Temporary visual highlight so a human can see what the extension found
 * before it acts (or, in confirm-required mode, before they click it
 * themselves). Self-removes so it never permanently alters Yahoo's page. */
export function highlightElement(el, durationMs = 5000) {
  if (!el) return;
  const prevOutline = el.style.outline;
  const prevOffset = el.style.outlineOffset;
  el.style.outline = "3px solid #1d4ed8";
  el.style.outlineOffset = "2px";
  el.scrollIntoView?.({ block: "center", behavior: "smooth" });
  setTimeout(() => {
    el.style.outline = prevOutline;
    el.style.outlineOffset = prevOffset;
  }, durationMs);
}

export function clickElement(el) {
  el?.click?.();
}
