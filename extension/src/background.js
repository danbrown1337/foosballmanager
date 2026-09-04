/*
 * Service worker: routes messages between the popup, the content script,
 * and the storage-backed engine in snapshot.js. Holds no state of its own
 * beyond a badge counter — everything real lives in chrome.storage.local,
 * so the worker can be killed and restarted by Chrome (normal MV3
 * behavior) without losing anything.
 */
import {
  buildSnapshot,
  importPicks,
  markPick,
  undoPick,
  autopickCommit,
  resetDraft,
  recordDetectedPicks,
} from "./lib/snapshot.js";

async function setBadge(text) {
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color: "#1d4ed8" });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handle(message, sender)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((err) => sendResponse({ ok: false, error: String(err.message || err) }));
  return true; // keep the message channel open for the async response
});

async function handle(message, sender) {
  switch (message.type) {
    case "GET_SNAPSHOT":
      return buildSnapshot();

    case "IMPORT_PICKS": {
      // Explicit attribution, unlike DETECTED_PICKS which is always "rival".
      const result = await importPicks(message.names, message.by);
      if (result.changed) await setBadge("\u2022");
      return result;
    }

    case "MARK_PICK":
      return markPick(message.name, message.by);

    case "UNDO_PICK":
      return undoPick(message.name);

    case "AUTOPICK":
      return autopickCommit(!!message.commit);

    case "RESET_DRAFT":
      return resetDraft();

    case "DETECTED_PICKS": {
      // From a draft-room content script poll. Always recorded as "rival" —
      // the user's own picks are only ever marked deliberately (via the
      // popup or the overlay's explicit "I took this" button), never
      // inferred from what changed on the page. Same rule browser_sync.py's
      // `watch` command follows for the same reason: guessing wrong would
      // misattribute the user's own pick to an opponent.
      const changed = await recordDetectedPicks(message.names, "rival");
      if (changed) await setBadge("•");
      return { changed };
    }

    default:
      throw new Error(`Unknown message type: ${message.type}`);
  }
}

// Note: chrome.action.onClicked never fires once a default_popup is set —
// Chrome opens the popup instead of dispatching the click event. The badge
// is cleared from popup.js on open instead.
chrome.runtime.onInstalled.addListener(() => setBadge(""));
