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
  syncMyTeam,
  setPracticeMode,
  shortlist,
  queuePlan,
  repairBoard,
  recordRoomAdp,
  recordRoomProjection,
  recordRoomStatus,
  refreshConsensusAdp,
  markPick,
  undoPick,
  autopickCommit,
  resetDraft,
  recordDetectedPicks,
  recordDecision,
  recordTurn,
  gradeDraft,
} from "./lib/snapshot.js";
import { Storage } from "./lib/storage.js";

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
      return buildSnapshot({
        picksUntilTurn: message.picksUntilTurn ?? null,
        teams: message.teams ?? null,
        format: message.format ?? null,
        exclude: message.exclude ?? null,
      });

    case "IMPORT_PICKS": {
      // Explicit attribution, unlike DETECTED_PICKS which is always "rival".
      const result = await importPicks(message.names, message.by);
      if (result.changed) await setBadge("\u2022");
      return result;
    }

    case "SYNC_MY_TEAM":
      return syncMyTeam(message.names || [], message.keep || []);

    case "SET_PRACTICE":
      return setPracticeMode(!!message.active);

    case "GET_SHORTLIST":
      return shortlist(message.n || 5, {
        round: message.round ?? null,
        picksUntilTurn: message.picksUntilTurn ?? null,
        teams: message.teams ?? null,
        format: message.format ?? null,
        exclude: message.exclude ?? null,
      });

    case "GET_QUEUE_PLAN":
      return queuePlan(message.n || 5, {
        round: message.round ?? null,
        picksUntilTurn: message.picksUntilTurn ?? null,
        teams: message.teams ?? null,
        format: message.format ?? null,
        exclude: message.exclude ?? null,
      });

    case "RECORD_TURN":
      return recordTurn(message.entry);

    case "RECORD_DECISION":
      return recordDecision(message.entry);

    case "GET_ROOM_LOGS":
      return Storage.getAllRoomLogs();

    case "GRADE_DRAFT":
      return gradeDraft();

    case "REPAIR_BOARD":
      return repairBoard(message.names, { markMissing: message.markMissing !== false });

    case "RECORD_ROOM_STATUS":
      return recordRoomStatus(message.entries);

    case "RECORD_ROOM_PROJECTION":
      return recordRoomProjection(message.entries);

    case "RECORD_ROOM_ADP":
      return recordRoomAdp(message.entries);

    case "REFRESH_CONSENSUS_ADP":
      return refreshConsensusAdp();

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


/* A clock outside the tab.
 *
 * Chrome throttles a hidden tab's timers to roughly once a minute, which is
 * longer than a pick clock — three gaps of 16, 52 and 28 seconds in one draft,
 * every turn inside one handed to Yahoo's autodraft. The page's own
 * MutationObserver covers a room that is still changing, but a room that has
 * gone quiet while it waits for somebody mutates nothing, and a throttled
 * timer will not notice the turn arrive.
 *
 * A service worker alarm is not a tab timer and is not throttled with one. It
 * fires, finds any draft room we have a content script in, and tells it to
 * look. What the page can then do while hidden is still limited — rendering
 * is suspended, so scrolling the list reveals nothing — but noticing your turn
 * and clicking a player already on screen needs neither.
 */
const HEARTBEAT = "fm-heartbeat";
const HEARTBEAT_MINUTES = 0.5; // the shortest period Chrome will honour

chrome.alarms.create(HEARTBEAT, { periodInMinutes: HEARTBEAT_MINUTES });

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== HEARTBEAT) return;
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: "https://*.fantasysports.yahoo.com/draftclient/*" });
  } catch {
    return; // no matching tabs, or the query is not permitted here
  }
  for (const tab of tabs) {
    // A tab whose content script has gone (navigated away, discarded) rejects
    // this, and there is nothing useful to do about it.
    chrome.tabs.sendMessage(tab.id, { type: "HEARTBEAT" }).catch(() => {});
  }
});
