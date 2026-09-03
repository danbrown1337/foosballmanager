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

/** Find the best element to click to select `playerName` on the page.
 * Walks up from the matching text node looking for the nearest ancestor
 * that looks interactive (button/link/role=button/onclick); falls back to
 * the text node's immediate parent element if nothing more specific is
 * found within `maxAncestorDepth`, since many draft rooms attach a click
 * handler directly to a row div rather than using a real <button>. */
export function findPlayerClickTarget(root, playerName, { maxAncestorDepth = 6 } = {}) {
  const doc = root.ownerDocument || root;
  const re = new RegExp(`(?<!\\w)${escapeRegExp(playerName)}(?!\\w)`);
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue || !re.test(node.nodeValue)) return NodeFilter.FILTER_SKIP;
      if (isInsideOwnOverlay(node.parentElement)) return NodeFilter.FILTER_SKIP;
      return NodeFilter.FILTER_ACCEPT;
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
  const wanted = phrases.map((p) => p.trim().toLowerCase()).filter(Boolean);

  for (const el of candidates) {
    if (isInsideOwnOverlay(el)) continue;
    const text = (el.textContent || "").trim().toLowerCase();
    if (!text || text.length > 40) continue;
    if (wanted.includes(text)) return el;
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
