/*
 * Injected into every fantasysports.yahoo.com page. Draws a small floating
 * panel showing the current recommendation, and polls the page's own
 * rendered text (never Yahoo's DOM structure — no CSS selectors, nothing
 * that breaks when Yahoo changes a class name) for opponent picks using the
 * exact same "search for known ADP names" strategy already proven in
 * fantasy_manager/browser_sync.py's `watch` command.
 *
 * DELIBERATE LIMIT: by default, this only reads the page — roster changes
 * and trades are never touched here, full stop, and drafting itself only
 * clicks anything if you explicitly opt into auto-draft below (off by
 * default). That mirrors the call already made for trades throughout this
 * project (Yahoo's API is read-only, and scripting real actions risks
 * looking like bot activity against Yahoo's terms); auto-draft is the one
 * deliberate, opt-in exception, scoped to drafting only.
 *
 * Your own pick is never inferred from what changed on the page — only
 * opponent picks are auto-detected (recorded as "rival"). You confirm your
 * own picks with one click on the recommended player, the same two-step
 * split browser_sync.py's `watch` mode already uses (it detects rivals
 * automatically; you commit your own pick yourself, deliberately).
 *
 * AUTO-DRAFT (opt-in, off by default): the one exception to "never clicks
 * Yahoo's own UI" above. When enabled, this watches the page's text for a
 * configurable "it's your turn" phrase and, if it finds one, locates the
 * recommended player's row on the page (by visible text, same as
 * everywhere else in this project — see lib/domActions.js) and clicks it.
 * By default it stops there: selecting a player is easy to undo (nothing
 * has been submitted yet), but the actual "confirm this pick" click is not,
 * so that click is left to you unless "fully automatic" is separately
 * turned on. Trades and roster moves are NOT part of this — they're
 * untouched, still fully manual, per the rest of this file's comments.
 */

// NOT a static top-level `import`: a content script declared in the
// manifest's content_scripts list runs as a classic (non-module) script
// regardless of any "type": "module" hint — confirmed by actually injecting
// this file into a real page, where a static import threw "Cannot use
// import statement outside a module". Dynamic import() works in any script
// context, module or not, so that's what loads the shared engine code here.
let findBoardNames;

const POLL_INTERVAL_MS = 4000;

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!response) return reject(new Error("No response from background worker."));
      if (!response.ok) return reject(new Error(response.error));
      resolve(response.result);
    });
  });
}

// --- panel -------------------------------------------------------------

function buildPanel() {
  const root = document.createElement("div");
  root.id = "fantasy-manager-overlay";
  root.innerHTML = `
    <style>
      #fantasy-manager-overlay {
        all: initial;
        position: fixed; bottom: 16px; right: 16px; z-index: 2147483647;
        font: 13px/1.4 system-ui, -apple-system, sans-serif;
        width: 300px; max-width: 90vw;
        background: #14161a; color: #e8eaed;
        border: 1px solid #2a2f38; border-radius: 10px;
        box-shadow: 0 8px 24px rgba(0,0,0,.35);
        overflow: hidden;
      }
      #fm-head { display: flex; align-items: center; gap: 8px; padding: 8px 10px;
                 background: #1d4ed8; color: #fff; cursor: pointer; user-select: none; }
      #fm-head b { font-size: 12px; letter-spacing: .02em; }
      #fm-ver { flex: 1; font-size: 10px; opacity: .75; }
      #fm-ver.degraded { color: #ffb454; opacity: 1; }
      #fm-body { padding: 10px; display: block; }
      #fm-body.collapsed { display: none; }
      #fm-rec-name { font-size: 15px; font-weight: 700; margin-bottom: 2px; }
      #fm-rec-why { color: #9aa1ab; font-size: 12px; margin-bottom: 8px; }
      #fm-rec-flag { color: #fbbf24; font-size: 11px; font-weight: 650; margin-bottom: 6px; }
      #fm-take { width: 100%; padding: 7px; border: none; border-radius: 6px;
                 background: #1d4ed8; color: #fff; font-weight: 600; cursor: pointer;
                 font: inherit; margin-bottom: 8px; }
      #fm-take:disabled { opacity: .5; cursor: default; }
      #fm-update.stale { border-color: #f59e0b; color: #fbbf24; }
      #fm-reset { width: 100%; padding: 6px; border: 1px solid #2a2f38; border-radius: 6px;
                  background: #1e222a; color: #9aa1ab; font: inherit; font-size: 11px;
                  cursor: pointer; margin-bottom: 8px; }
      #fm-reset.armed { border-color: #b91c1c; color: #fca5a5; }
      #fm-pool { width: 100%; padding: 6px; border: 1px solid #2a2f38; border-radius: 6px;
                 background: #1e222a; color: #9aa1ab; font: inherit; font-size: 11px;
                 cursor: pointer; margin-bottom: 8px; }
      #fm-update { width: 100%; padding: 6px; border: 1px solid #2a2f38; border-radius: 6px;
                 background: #1e222a; color: #9aa1ab; font: inherit; font-size: 11px;
                 cursor: pointer; margin-bottom: 8px; }
      #fm-log { font-size: 11px; color: #9aa1ab; max-height: 70px; overflow-y: auto;
                border-top: 1px solid #2a2f38; padding-top: 6px; }
      #fm-log div { padding: 1px 0; }
      #fm-status { font-size: 10px; color: #6b7280; margin-top: 6px; }
      #fm-toggle-poll { font-size: 10px; color: #9aa1ab; cursor: pointer; text-decoration: underline; }
      #fm-mode { font-size: 10px; background: #1e222a; color: #9aa1ab; border: 1px solid #2a2f38;
                 border-radius: 4px; padding: 1px 2px; }
      #fm-err { color: #fca5a5; font-size: 11px; margin-top: 6px; }
      #fm-shape { background: #78350f; color: #fde68a; font-size: 10px; font-weight: 700;
                  padding: 4px 10px; }
      #fm-practice { background: #78350f; color: #fde68a; font-size: 10px; font-weight: 700;
                     letter-spacing: .04em; padding: 4px 10px; }
      #fm-dead { border-top: 1px solid #2a2f38; margin-top: 8px; padding-top: 8px;
                 color: #fca5a5; font-size: 11px; }
      #fm-dead b { color: #fecaca; }
      #fm-reload { width: 100%; margin-top: 6px; padding: 6px; border: none; border-radius: 6px;
                   background: #b91c1c; color: #fff; font: inherit; font-weight: 600; cursor: pointer; }
      #fm-queue-row { display: flex; align-items: center; gap: 6px; font-size: 11px;
                      color: #9aa1ab; cursor: pointer; margin-bottom: 6px; }
      #fm-practice-row { display: flex; align-items: center; gap: 6px; font-size: 11px;
                         color: #9aa1ab; cursor: pointer; margin-bottom: 6px; }
      #fm-auto { border-top: 1px solid #2a2f38; margin-top: 8px; padding-top: 8px; font-size: 11px; }
      #fm-auto label { display: flex; align-items: center; gap: 6px; color: #9aa1ab; margin-bottom: 4px; cursor: pointer; }
      #fm-auto label.sub { padding-left: 16px; }
      #fm-auto-status { color: #6b7280; font-size: 10px; margin-top: 2px; }
      #fm-auto-warn { color: #fbbf24; font-size: 10px; margin-top: 2px; }
    </style>
    <div id="fm-head">
      <b>Fantasy Manager</b>
      <span id="fm-ver"></span>
      <span id="fm-collapse-icon">–</span>
    </div>
    <div id="fm-practice" hidden>PRACTICE SETTINGS — not your league</div>
    <div id="fm-shape" hidden></div>
    <div id="fm-body">
      <div id="fm-rec-flag" hidden></div>
      <div id="fm-rec-name">Loading…</div>
      <div id="fm-rec-why"></div>
      <button id="fm-take" disabled>I drafted this player</button>
      <button id="fm-update">Update board from Yahoo</button>
      <button id="fm-pool">Import players and ADP</button>
      <button id="fm-reset">New draft — clear picks</button>
      <div id="fm-log"></div>
      <div id="fm-status">
        watching page (opponent picks + auto-draft) —
        <span id="fm-toggle-poll">pause</span>
        · <select id="fm-mode" title="Which direction signals a pick on this page">
            <option value="auto">auto-detect</option>
            <option value="appear">names appear (picks feed)</option>
            <option value="disappear">names disappear (player pool)</option>
          </select>
      </div>
      <div id="fm-err" hidden></div>
      <div id="fm-dead" hidden>
        <b>Disconnected — this panel is out of date.</b>
        The extension was reloaded or updated while this page was open, so it
        can no longer see the draft or record a pick.
        <button id="fm-reload">Reload this page to reconnect</button>
      </div>
      <label id="fm-queue-row">
        <input type="checkbox" id="fm-queue-enable"> Keep Yahoo's queue filled (drafts even if this tab sleeps)
      </label>
      <label id="fm-practice-row">
        <input type="checkbox" id="fm-practice-toggle"> Practice mode — use this room's roster
      </label>
      <div id="fm-auto">
        <label><input type="checkbox" id="fm-auto-enable"> Auto-draft when it's my turn (experimental)</label>
        <label class="sub" id="fm-auto-full-row" hidden>
          <input type="checkbox" id="fm-auto-full"> Fully automatic — also click Yahoo's Confirm/Draft button
        </label>
        <div id="fm-auto-status"></div>
        <div id="fm-auto-warn" hidden>Test this against a Yahoo mock draft before trusting it live. Edit turn phrases in Options if a turn goes undetected.</div>
      </div>
    </div>
  `;
  document.documentElement.appendChild(root);
  return root;
}

async function main() {
  let fetchPool, leagueIdFromUrl, diffDrafted, findMyTeamNames, findRosterSlots, findRosterTotal, findAmbiguousAbbrevs,
    findQueueNames, withoutQueuePanel, parseDraftSlot, parseDraftPosition, picksUntilMyTurn,
    teamCountBounds, defenceAliases, parseDraftResults, teamsFromRoundChange,
    parseRosterFormat, draftRoomId, parseLastPick,
    Storage, isMyTurn, looksLikeAFutureTurn, findPlayerClickTarget, findConfirmClickTarget,
    highlightElement, clickElement, DEFAULT_CONFIRM_PHRASES, findPlayerSearchBox,
    setInputValue, surnameOf, findListScroller, findQueueStar, findDraftButton,
    findQueueRemove, looksUnavailableOnPage, rowShowsNoAdp, readRoomAdp, readRoomStatuses,
    readRoomProjections, describeRow, findPanelTab, sweepTrust, Attempts;
  ({ findBoardNames, diffDrafted, findMyTeamNames, findRosterSlots, findRosterTotal,
     findAmbiguousAbbrevs, findQueueNames, withoutQueuePanel,
     parseDraftSlot, parseDraftPosition, picksUntilMyTurn, teamCountBounds,
     defenceAliases, parseDraftResults, teamsFromRoundChange, parseRosterFormat,
     draftRoomId, parseLastPick } =
    await import(chrome.runtime.getURL("src/lib/textMatch.js")));
  ({ Storage } = await import(chrome.runtime.getURL("src/lib/storage.js")));
  ({ fetchPool, leagueIdFromUrl } = await import(chrome.runtime.getURL("src/lib/yahooPool.js")));
  ({ isMyTurn, looksLikeAFutureTurn } = await import(chrome.runtime.getURL("src/lib/turnDetect.js")));
  ({ sweepTrust } = await import(chrome.runtime.getURL("src/lib/sweepTrust.js")));
  ({ Attempts } = await import(chrome.runtime.getURL("src/lib/attempts.js")));
  ({ findPlayerClickTarget, findConfirmClickTarget, highlightElement, clickElement,
     DEFAULT_CONFIRM_PHRASES, findPlayerSearchBox, setInputValue, surnameOf,
     findListScroller, findQueueStar, findDraftButton, findQueueRemove,
     looksUnavailableOnPage, rowShowsNoAdp, readRoomAdp, readRoomProjections,
     readRoomStatuses, describeRow, findPanelTab } =
    await import(chrome.runtime.getURL("src/lib/domActions.js")));

  /* Every helper this panel uses is destructured from a dynamic import, and a
   * name added to the declaration but missed in the assignment stays
   * undefined until the moment it is needed — mid-draft, inside a catch that
   * says nothing useful. Three separate debugging rounds went that way. Check
   * once, at load, and say which one is missing. */
  const wired = {
    findBoardNames, diffDrafted, findMyTeamNames, findRosterSlots, findRosterTotal,
    findAmbiguousAbbrevs, findQueueNames, withoutQueuePanel, parseDraftSlot,
    parseDraftPosition, picksUntilMyTurn, teamCountBounds, defenceAliases,
    parseDraftResults, teamsFromRoundChange, parseRosterFormat, draftRoomId,
    parseLastPick, isMyTurn,
    looksLikeAFutureTurn, findPlayerClickTarget, findConfirmClickTarget,
    highlightElement, clickElement, findPlayerSearchBox, setInputValue, surnameOf,
    findListScroller, findQueueStar, findDraftButton, findQueueRemove,
    looksUnavailableOnPage, rowShowsNoAdp, readRoomAdp, readRoomStatuses,
    readRoomProjections, describeRow, findPanelTab, fetchPool,
    leagueIdFromUrl, sweepTrust, Attempts,
  };
  const unbound = Object.keys(wired).filter((name) => typeof wired[name] !== "function");
  if (unbound.length > 0) {
    console.error("Fantasy Manager: unbound helpers —", unbound.join(", "));
  }

  const root = buildPanel();
  const body = root.querySelector("#fm-body");
  const head = root.querySelector("#fm-head");
  const recName = root.querySelector("#fm-rec-name");
  const recWhy = root.querySelector("#fm-rec-why");
  const recFlag = root.querySelector("#fm-rec-flag");
  const takeBtn = root.querySelector("#fm-take");
  const log = root.querySelector("#fm-log");
  const errBox = root.querySelector("#fm-err");
  const pollToggle = root.querySelector("#fm-toggle-poll");
  const modeSelect = root.querySelector("#fm-mode");
  const autoEnableBox = root.querySelector("#fm-auto-enable");
  const autoFullRow = root.querySelector("#fm-auto-full-row");
  const autoFullBox = root.querySelector("#fm-auto-full");
  const autoStatus = root.querySelector("#fm-auto-status");
  const autoWarn = root.querySelector("#fm-auto-warn");
  const deadBox = root.querySelector("#fm-dead");
  const practiceBox = root.querySelector("#fm-practice");
  const updateBtn = root.querySelector("#fm-update");
  const poolBtn = root.querySelector("#fm-pool");
  /* Which build is actually running. Reloading the extension without
   * reloading the page leaves an old content script in place, and a stale
   * panel is indistinguishable from a current one until something it should
   * do doesn't happen. */
  try {
    root.querySelector("#fm-ver").textContent = `v${chrome.runtime.getManifest().version}`;
  } catch {
    // Context already gone; handleDeadContext will say so.
  }
  const shapeBox = root.querySelector("#fm-shape");
  const practiceToggle = root.querySelector("#fm-practice-toggle");
  const resetBtn = root.querySelector("#fm-reset");
  const queueBox = root.querySelector("#fm-queue-enable");
  const statusBox = root.querySelector("#fm-status");

  let polling = true;
  let contextGone = false;
  let timers = [];
  let observers = [];
  let lastPollAt = Date.now();
  /* Declared up here because addLog uses it, and addLog runs from the moment
   * the panel exists. */
  const roomId = draftRoomId ? draftRoomId(location.href) : null;
  let previousBoardNames = null;
  /* Where the list was standing when those names were read.
   *
   * The player list is virtualised: perhaps twenty rows exist in the DOM at
   * any moment, and scrolling swaps them. Comparing two samples taken at
   * different scroll positions therefore says nothing about who was drafted —
   * every row that scrolled out of view looks exactly like a player who left
   * the pool. A live draft that had not yet made its first pick recorded
   * seventeen picks that way, all of them bottom-of-the-list players, because
   * queue maintenance had scrolled down to star someone and the next poll
   * found the list back at the top. */
  let previousScrollTop = null;
  /* How many picks one poll may believe in. Four seconds, one room, one pick
   * at a time — anything past this is the page changing under us. */
  const MAX_PICKS_PER_POLL = 3;
  // Often enough to stay current, rarely enough that the queue panel is
  // almost always the one on screen.
  const PICKS_SYNC_MS = 45000;
  const PICKS_SYNC_ENABLED = false;
  let boardNameSet = null;
  let boardPlayers = null;
  let lastConfig = null;
  /* Set while the room's search box is filtered: the filter removes most of
   * the board from the page text, and the pick detector would read that as
   * every one of those players being drafted at once. */
  let detectionSuspended = false;
  /* The exact text we last typed into the room's search box. If a cycle is
   * interrupted — a throw, a reload, a turn arriving mid-search — the filter
   * is left in place, and every later lookup searches a list narrowed to
   * somebody else. Seen live: "Wilson" sat in the box while the panel
   * reported it couldn't confirm player after player. */
  let searchWeTyped = null;
  const QUEUE_DEPTH = 5;
  /* Deeper while the tab is hidden. The panel cannot reliably act there, so
   * the queue is what drafts for you — Yahoo picks from it without needing
   * this tab awake at all. Depth is the whole mitigation, so it goes up. */
  const QUEUE_DEPTH_HIDDEN = 8;
  // Deeper whenever the panel cannot act reliably — hidden, or reading a list
  // that will not render. The queue is what drafts for you in both cases.
  const queueDepth = () =>
    (document.hidden || headerState ? QUEUE_DEPTH_HIDDEN : QUEUE_DEPTH);
  let queueEnabled = false;
  let lastQueueRunAt = 0;
  /* Queue maintenance and a board update both drive the room's search box.
   * Whichever starts second must wait, or it reads a list the other one is
   * filtering — which is how pressing Update mid-cycle got told to clear a
   * search the user never typed. */
  let roomBusy = false;
  // Set when a refresh attempt cannot succeed here, as opposed to simply not
  // having run yet. See the queue's staleness gate.
  let boardRefreshBlocked = false;
  /* What we put in the room's queue. Yahoo removes a player from the queue
   * when someone drafts him, so anything that leaves this set without us
   * drafting him is a pick we never saw — the cheapest, most reliable pick
   * detector available, and it costs nothing to read. */
  const queuedByUs = new Set();
  const reportedAmbiguous = new Set();
  let currentRecName = null;
  let currentRecReason = null;
  let currentAlternatives = null;
  let turnPhrases = [];
  let confirmPhrases = [];
  let turnActive = false;   // was the "your turn" phrase present last poll
  let turnHandled = false;  // already acted on this turn (reset when the phrase clears)
  const TURN_CONFIDENCE_TICKS = 2;
  let turnConfidence = 0;
  /* Which pick number was acted on last. At the snake's turn you pick twice in
   * a row and the banner never clears between them, so "already handled" has
   * to mean this pick rather than this stretch of banner — otherwise the
   * second pick is silently skipped. */
  let handledPick = null;

  head.addEventListener("click", () => {
    body.classList.toggle("collapsed");
    root.querySelector("#fm-collapse-icon").textContent = body.classList.contains("collapsed") ? "+" : "–";
  });

  root.querySelector("#fm-reload").addEventListener("click", () => location.reload());

  Storage.getPollMode().then((mode) => { modeSelect.value = mode; });
  modeSelect.addEventListener("change", () => {
    Storage.setPollMode(modeSelect.value);
    previousBoardNames = null;
    previousScrollTop = null; // avoid a false diff across a mode switch
  });

  pollToggle.addEventListener("click", () => {
    polling = !polling;
    pollToggle.textContent = polling ? "pause" : "resume";
    updateAutoStatus();
  });

  function updateAutoStatus() {
    if (!autoEnableBox.checked) {
      autoStatus.textContent = "off — picks stay manual";
      autoWarn.hidden = true;
      return;
    }
    if (!polling) {
      autoStatus.textContent = "PAUSED — will not click anything until you hit resume";
      autoWarn.hidden = true;
      return;
    }
    autoStatus.textContent = autoFullBox.checked
      ? "on, fully automatic — watching for your turn"
      : "on, auto-fill only — watching for your turn (you confirm)";
    autoWarn.hidden = false;
  }

  Storage.getAutoDraftEnabled().then((enabled) => {
    autoEnableBox.checked = enabled;
    autoFullRow.hidden = !enabled;
    updateAutoStatus();
  });
  Storage.getAutoDraftFullyAutomatic().then((full) => { autoFullBox.checked = full; });
  Storage.getTurnPhrases().then((phrases) => {
    turnPhrases = phrases;
    addLog(`Watching for ${phrases.length} turn phrases.`);
  });
  Storage.getConfirmPhrases().then((phrases) => { confirmPhrases = phrases; });

  function inferDraftedFromPoll(previous, current, fallbackMode) {
    if (!previous) return new Set();
    if (fallbackMode !== "auto") {
      return diffDrafted(previous, current, fallbackMode);
    }

    // In auto-detect mode, tolerate both Yahoo page patterns:
    // * a running picks feed where newly drafted names appear,
    // * a player-pool list where drafted names disappear.
    const appear = diffDrafted(previous, current, "appear");
    const disappear = diffDrafted(previous, current, "disappear");
    if (appear.size === 0) return disappear;
    if (disappear.size === 0) return appear;

    const prevSize = previous.size;
    const currSize = current.size;
    if (currSize < prevSize) return disappear;
    if (currSize > prevSize) return appear;
    return appear.size >= disappear.size ? appear : disappear;
  }

  autoEnableBox.addEventListener("change", () => {
    Storage.setAutoDraftEnabled(autoEnableBox.checked);
    autoFullRow.hidden = !autoEnableBox.checked;
    turnConfidence = 0;
    turnHandled = false;
    turnActive = false;
    updateAutoStatus();
  });
  autoFullBox.addEventListener("change", () => {
    Storage.setAutoDraftFullyAutomatic(autoFullBox.checked);
    updateAutoStatus();
  });

  function showError(message) {
    errBox.hidden = !message;
    errBox.textContent = message || "";
  }

  /* Chrome tears the runtime connection out from under a content script when
   * the extension is reloaded or updated, leaving this script running in a
   * page it can no longer talk to. Every chrome.runtime call throws from then
   * on, and only a page reload brings it back. */
  function isContextGone(err) {
    const msg = String((err && err.message) || err || "");
    return msg.includes("Extension context invalidated") ||
           msg.includes("Receiving end does not exist") ||
           msg.includes("message port closed");
  }

  /* A disconnected panel still showing its last recommendation is worse than
   * no panel at all: mid-draft it looks authoritative while being unable to
   * see a single pick. Say so plainly, stop everything that could act on
   * stale data, and offer the one thing that fixes it. */
  function handleDeadContext() {
    if (contextGone) return;
    contextGone = true;
    polling = false;
    for (const t of timers) clearInterval(t);
    timers = [];
    // The observer drives the turn check too, so a dead context has to stop
    // it as well or the panel keeps acting on a board it can no longer read.
    for (const o of observers) o.disconnect();
    observers = [];
    takeBtn.disabled = true;
    autoEnableBox.disabled = true;
    autoFullBox.disabled = true;
    recWhy.textContent = "Anything above is stale — it stopped updating when the extension reloaded.";
    recFlag.hidden = true;
    statusBox.hidden = true;
    showError(null);
    deadBox.hidden = false;
  }

  function render(snapshot) {
    lastConfig = snapshot.config;
    // Shown outside the collapsible body: a mock-settings warning is useless
    // if it's hidden behind the panel being collapsed.
    practiceBox.hidden = !snapshot.practice;
    practiceToggle.checked = !!snapshot.practice;
    const rec = snapshot.recommendation;
    currentRecName = rec ? rec.name : null;
    // Kept for the decision record: what was chosen, why, and over whom.
    currentRecReason = rec ? rec.reason : null;
    currentAlternatives = rec?.alternatives ?? null;
    recName.textContent = rec ? `${rec.name} — ${rec.pos}, ${rec.team}` : "Board is empty";
    recWhy.textContent = rec ? rec.reason : "";
    recFlag.hidden = !(rec && rec.needOverride);
    if (rec && rec.needOverride) recFlag.textContent = "Forced pick — a starter slot is about to go unfilled";
    takeBtn.disabled = !rec;
  }

  async function refresh() {
    try {
      const snapshot = await sendMessage({ type: "GET_SNAPSHOT", picksUntilTurn, teams: detectedTeams, format: detectedFormat, exclude: unconfirmed.restingKeys() });
      render(snapshot);
      showError(null);
      return snapshot;
    } catch (err) {
      if (isContextGone(err)) return handleDeadContext(), null;
      showError(String(err.message || err));
      return null;
    }
  }

  takeBtn.addEventListener("click", async () => {
    if (!currentRecName) return;
    takeBtn.disabled = true;
    try {
      await sendMessage({ type: "MARK_PICK", name: currentRecName, by: "mine" });
      addLog(`You took ${currentRecName}`);
      await refresh();
    } catch (err) {
      showError(String(err.message || err));
      takeBtn.disabled = false;
    }
  });

  /* Written to storage as well as to the panel, throttled so a busy draft
   * does not write on every line. The log was in the DOM and nowhere else, so
   * a reload destroyed the account of whatever had just gone wrong — which is
   * precisely the moment a reload tends to happen. */
  let logLines = [];
  let logFlushAt = 0;
  function flushLog(force = false) {
    if (!roomId) return;
    const now = Date.now();
    if (!force && now - logFlushAt < 2000) return;
    logFlushAt = now;
    Storage.setRoomLog(roomId, logLines).catch(() => {});
  }

  function addLog(text) {
    logLines.push(`${new Date().toISOString().slice(11, 19)} ${text}`);
    if (logLines.length > 200) logLines = logLines.slice(-200);
    flushLog();

    const line = document.createElement("div");
    line.textContent = text;
    log.prepend(line);
    // Twenty, not six: the panel is the only account of what it did, and a
    // busy turn was scrolling away the very lines needed to explain a
    // feature that looked silent.
    while (log.children.length > 20) log.removeChild(log.lastChild);
  }

  /* The room states your roster outright ("YOUR TEAM (5/15)"), so read it
   * rather than making you click Mine five times. Additive only: this can
   * add a player to your team or correct one previously recorded as a
   * rival's, never take one away. */
  /* The room's own slot labels are the league's starter construction. If it
   * shows a slot the configured league doesn't start, every player at that
   * position is unrostable to the engine — it will never recommend one, and
   * the unfilled-starter guardrail reads the same config so it stays silent
   * too. That combination emptied a kicker slot in live testing. */
  function checkRosterShape(text, config) {
    if (!findRosterSlots || !config) return;

    /* What the room says its format is, taken over what the settings say.
     *
     * Everything downstream rests on this — replacement level, the need
     * gradient, the depth targets, which round kickers unlock, how many picks
     * are left — and until now it was typed in by hand. A mock room starts a
     * kicker and one flex; the league it is practising for starts no kicker
     * and two. Scoring one as though it were the other is wrong in every rule
     * at once.
     *
     * Session only, never written to settings, for the same reason: what a
     * mock room says must not overwrite the real league's configuration. */
    if (parseRosterFormat) {
      const format = parseRosterFormat(text);
      if (format && JSON.stringify(format.starters) !== JSON.stringify(detectedFormat?.starters)) {
        detectedFormat = format;
        Storage.setRoomFacts(roomId, { format }).catch(() => {});
        const shown = Object.entries(format.starters)
          .map(([pos, n]) => (n > 1 ? `${n}x${pos}` : pos)).join(" ");
        addLog(`This room's format: ${shown}, ${format.bench} bench (${format.total} picks) — using it for every calculation from here.`);
      }
    }
    const starters = config.roster?.starters || {};

    /* The size check first, because getting this wrong is not a nuance — the
     * engine derives "picks left" from sum(starters) + bench, and a config
     * describing a smaller roster than the room means it believes the draft
     * is nearly over from the first round. Seen live: a three-slot config in
     * a fifteen-slot room, which forced a kicker at round one and reported
     * "0 picks left" at round four. */
    const configured =
      Object.values(starters).reduce((a, b) => a + b, 0) + (config.roster?.bench || 0);
    const room = findRosterTotal ? findRosterTotal(text) : null;
    if (room && configured !== room.total) {
      shapeBox.textContent =
        `THIS ROOM DRAFTS ${room.total} PLAYERS — your settings add up to ${configured}. ` +
        `Recommendations will be wrong until they match. Fix the starters and bench in Settings.`;
      shapeBox.hidden = false;
      return;
    }

    const slots = findRosterSlots(text);
    const missing = ["K", "DEF"].filter((pos) => slots.has(pos) && !starters[pos]);
    if (missing.length === 0) {
      shapeBox.hidden = true;
      return;
    }
    shapeBox.textContent =
      `THIS ROOM STARTS ${missing.join(" AND ")} — your settings don't, so none will ever be recommended. Turn on practice mode in Settings.`;
    shapeBox.hidden = false;
  }

  /* Switching this from the panel is the whole point: the room tells you its
   * roster shape while you're sitting in it, and the settings tab is the last
   * place anyone wants to go with a pick clock running. Same swap the options
   * page performs, so the two cannot drift. */
  practiceToggle.addEventListener("change", async () => {
    try {
      /* Flip whatever is actually stored, not what this box happens to show.
       * The panel only re-renders every few seconds, so a click can land on a
       * stale checkbox — and sending its displayed value would then apply the
       * opposite of what was intended. */
      const current = await sendMessage({ type: "GET_SNAPSHOT" });
      const snapshot = await sendMessage({ type: "SET_PRACTICE", active: !current.practice });
      render(snapshot);
      addLog(snapshot.practice
        ? "Practice mode on — using this room's roster, your league's settings are saved."
        : "Practice mode off — your league's settings are back.");
    } catch (err) {
      if (isContextGone(err)) return handleDeadContext();
      showError(String(err.message || err));
      practiceToggle.checked = !practiceToggle.checked; // put the box back
    }
  });

  /* Draft state carries over between rooms, so a fresh mock opens with the
   * last one's picks still recorded and recommends against a draft that
   * already happened. Reset existed only in the settings page — and the
   * moment you need it is while sitting in the new room.
   *
   * Two clicks rather than a confirm() dialog: this runs inside Yahoo's page,
   * and blocking it with a modal during a draft is its own hazard. */
  let resetArmed = null;
  resetBtn.addEventListener("click", async () => {
    if (!resetArmed) {
      resetBtn.classList.add("armed");
      resetBtn.textContent = "Click again to clear every pick";
      resetArmed = setTimeout(() => {
        resetArmed = null;
        resetBtn.classList.remove("armed");
        resetBtn.textContent = "New draft — clear picks";
      }, 4000);
      return;
    }
    clearTimeout(resetArmed);
    resetArmed = null;
    resetBtn.classList.remove("armed");
    resetBtn.textContent = "New draft — clear picks";
    try {
      const snapshot = await sendMessage({ type: "RESET_DRAFT" });
      previousBoardNames = null;
      previousScrollTop = null;
      reportedAmbiguous.clear();
      turnActive = false;
      turnHandled = false;
      turnConfidence = 0;
      updateBtn.classList.remove("stale");
      render(snapshot);
      addLog("Board cleared — starting from an empty draft.");
    } catch (err) {
      if (isContextGone(err)) return handleDeadContext();
      showError(String(err.message || err));
    }
  });

  /* Find a player on the page, searching the room for them if they aren't
   * rendered. Returns the element and whether a search is currently open —
   * the caller must clear it. Polls for the row rather than waiting a fixed
   * interval, because a fixed wait turns a slow search into a false "not
   * there", and a false "not there" now means marking a player drafted. */
  /* The page text with the player list and queue panel removed, for deciding
   * whether it is actually your turn.
   *
   * The list carries a divider row reading "YOUR TURN - 22ND PICK", marking
   * where your next pick lands in the rankings. It is there permanently, and
   * the turn phrases match it — so the panel believed it was your turn for an
   * entire draft, which blocked queue maintenance on every cycle and produced
   * turn actions between other managers' picks. The real banner lives outside
   * the list. */
  /* Is a turn banner actually on the page — as opposed to the player list's
   * own divider, "YOUR TURN - 22ND PICK", which marks where your next pick
   * lands in the rankings and sits there permanently?
   *
   * Asked per text node rather than by cutting the list's text out of the
   * page's: innerText normalises differently on a container than on body, so
   * subtracting one from the other silently removed nothing, and the panel
   * went on believing it was your turn for a whole draft. Here the node's own
   * position decides — inside the list it doesn't count, outside it does. */
  /* The list's divider names a future pick — "YOUR TURN - 22ND PICK". The
   * room's real banner names the current one — "YOUR TURN \u2022 ROUND 4,
   * PICK 50". Rejecting the divider by its own shape as well as by position,
   * because position alone depends on finding the list, and a poll that
   * doesn't find it would claim a turn that isn't happening. */
  const RANKING_DIVIDER = /your turn\s*[-\u2013\u2014]\s*\d+\s*(st|nd|rd|th)?\s*pick/i;

  let lastTurnEvidence = "";
  function turnBannerPresent() {
    const scroller = findListScroller(document.body);
    const overlay = document.getElementById("fantasy-manager-overlay");
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) =>
        node.nodeValue && isMyTurn(node.nodeValue, turnPhrases)
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_SKIP,
    });
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const el = node.parentElement;
      if (!el) continue;
      if (scroller?.contains(el)) continue; // the ranking divider
      if (overlay?.contains(el)) continue; // our own panel's log
      const value = node.nodeValue.trim();
      // "You're up in 11 Picks" and the ranking divider both contain a turn
      // phrase and both mean it is somebody else's pick.
      if (looksLikeAFutureTurn(value)) continue;
      // Record what convinced it, so a wrong turn can be read off the panel
      // instead of inferred from the outside.
      if (value.slice(0, 60) !== lastTurnEvidence) {
        lastTurnEvidence = value.slice(0, 60);
        addLog(`Turn banner seen: "${lastTurnEvidence}"`);
      }
      return true;
    }
    return false;
  }

  const countNames = () =>
    (document.body.innerText.match(/(?<!\w)[A-Z]\.\s?[A-Za-z][A-Za-z'\u2019-]+/g) || []).length;

  /* The room renders most of the available list at once — a hundred-odd rows
   * of the hundred-odd players left. So when the list is that complete and a
   * player isn't in it, that is already the answer, and searching for him
   * costs five seconds to learn nothing. Only search when the list is too
   * short to draw a conclusion from. */
  /* Is this player's name on the page at all, in the form the room writes it?
   *
   * Distinct from matching him: the matcher declines an abbreviation shared by
   * two players, and with a 300-name pool imported from Yahoo those collisions
   * are common. Declining to identify someone is not evidence he is gone —
   * treating it that way marked Justin Jefferson drafted in round two, because
   * some other J. Jefferson exists in the pool. */
  function nameAppears(name, text) {
    if (text.includes(name)) return true;
    // A defence appears under its nickname, never under the board's name.
    const meta = (boardPlayers || []).find((p) => p.name === name);
    if (meta?.pos === "DEF" && defenceAliases) {
      for (const alias of defenceAliases(meta)) {
        if (new RegExp(`(?<!\\w)${alias}(?!\\w)`, "i").test(text)) return true;
      }
    }
    const parts = name.trim().split(/\s+/);
    if (parts.length < 2 || !surnameOf) return false;
    const last = surnameOf(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?<!\\w)${parts[0][0]}\\.\\s?${last}(?!\\w)`, "i").test(text);
  }

  /* Targets the room would not confirm, and when to try them again.
   *
   * Every loop here is bounded inside one cycle and none of that helped: the
   * cycle restarts every few seconds against the same board and re-derives
   * the same candidates, so bounded inner loops composed into an unbounded
   * outer one. A whole draft went by cycling Jeanty, Smith, Olave and
   * Williams — a full sweep of the player list for each — with the queue
   * empty and Yahoo autodrafting. Concluding "drafted" used to end it, and
   * that conclusion was wrong often enough to be worth removing, which left
   * nothing to stop the cycle.
   *
   * The ledger is what carries a failure from one cycle to the next. The
   * reasoning and its tests live in src/lib/attempts.js. */
  const UNCONFIRMED_TRIES = 3;
  const unconfirmed = new Attempts({ tries: UNCONFIRMED_TRIES, restMs: 90_000 });

  /* Records a miss, and concludes a pick once there have been enough of them.
   *
   * Making a single sweep's silence mean "drafted" was what buried seventy
   * available players, so that inference is now hard to earn. But refusing it
   * entirely leaves the opposite failure, and that one also cost a turn: the
   * board went on recommending Ashton Jeanty for a whole draft after somebody
   * took him during a throttled window, because nothing was allowed to notice
   * he had gone.
   *
   * Three separate walks to the bottom of a credible list, none of which
   * found him, is a different quality of evidence from one partial view — so
   * that is where the conclusion sits. Misses from a sweep that never got
   * down the list are not counted at all. */
  function noteUnconfirmed(name, sawList) {
    if (!sawList) return;
    if (!unconfirmed.fail(name)) return;
    if (!missingMeansDrafted) {
      addLog(`${name} not found in ${UNCONFIRMED_TRIES} full passes — resting him (not marking; this rule has been wrong today).`);
      return;
    }
    addLog(`${name} not found in ${UNCONFIRMED_TRIES} full passes of the room — marking drafted and resting him.`);
    markedByAbsence.add(name);
    sendMessage({ type: "IMPORT_PICKS", names: [name], by: "rival" }).catch(() => {
      // Nothing to do about it here; the next pass will try again.
    });
  }

  /* Whether the rule above is still trusted, and the evidence against it.
   *
   * It is a marking path, and marking paths are what buried seventy available
   * players once already. Rather than pick a threshold and hope, it watches
   * its own results: when a later sweep finds a player it had declared
   * drafted, that is the room contradicting it outright. Two of those and it
   * stops marking for the rest of the session — it goes on resting names, so
   * the loop it exists to break stays broken, but it no longer writes to the
   * board it has been shown to get wrong. */
  const MAX_ABSENCE_REVERSALS = 2;
  const markedByAbsence = new Set();
  let absenceReversals = 0;
  let missingMeansDrafted = true;

  /* Write down what was decided, at the moment it was decided.
   *
   * Yahoo does not keep mock drafts — its own confirmation email says so — so
   * a roster looked at afterwards has been the only evidence available, and
   * every question about this engine took a conversation to answer instead of
   * a lookup. The record is what the panel knew: which player, at which pick,
   * for what stated reason, and what it was choosing between. */
  function recordPickDecision(name) {
    const meta = (boardPlayers || []).find((p) => p.name === name) || null;
    const here = parseDraftPosition ? parseDraftPosition(document.body.innerText) : null;
    const teams = lastConfig?.league?.num_teams;
    sendMessage({
      type: "RECORD_DECISION",
      entry: {
        name,
        pos: meta?.pos ?? null,
        team: meta?.team ?? null,
        adp: meta?.adp ?? null,
        adpSource: meta?.adpSource ?? null,
        pick: here?.pick ?? null,
        round: here && teams ? Math.floor((here.pick - 1) / teams) + 1 : null,
        reason: currentRecReason || null,
        alternatives: currentAlternatives,
      },
    }).catch(() => {
      // A missed record is not worth interrupting a draft over.
    });
  }

  /* Why a control could not be found, and what that means.
   *
   * A taken player leaves the room's available list, but his name stays in
   * the pick feed and the "Last:" banner — so he still resolves, with no row
   * behind him and therefore no star and no Draft button. That is not a
   * failure to find a control; it is the room saying he is gone. A row that
   * is present but missing its control is the opposite, and must never be
   * read as a pick. Reported once per player either way, so the next
   * occurrence is diagnosable without anyone watching. */
  const describedRows = new Set();
  function explainMissingControl(name, meta, what) {
    if (!describeRow) return false;
    let shape;
    try {
      shape = describeRow(document.body, name, { player: meta });
    } catch {
      return false;
    }
    /* A row with nothing in it means he is not in the list.
     *
     * findPlayerClickTarget prefers a match in a row that has cells, so a
     * contentless one coming back means no real row holds this name — the
     * match is in the queue panel, the pick feed or a leftover shell. That is
     * the same fact as having no row at all: he has been drafted. Reading it
     * as "his row is there but the button is missing" is what had the panel
     * asking for Jameson Williams and Chase Brown at turn after turn, neither
     * of whom was in the room. */
    const emptyRow = shape.cells === 0 && shape.controls === 0;
    const gone = shape.found && (!shape.inTable || emptyRow);
    if (!describedRows.has(name)) {
      describedRows.add(name);
      addLog(gone
        ? `${name}: name is on the page but he has no row in the player list — he has been drafted.`
        : `${name}: row present (${shape.cells} cells, ${shape.controls} controls, icons ${shape.icons.join("/") || "none"}) but no ${what}.`);
    }
    return gone;
  }

  function checkAbsenceRule(freedNames) {
    if (!missingMeansDrafted || !freedNames?.length) return;
    for (const name of freedNames) {
      if (!markedByAbsence.delete(name)) continue;
      absenceReversals++;
      addLog(`${name} is back in the room after being marked drafted — that call was wrong.`);
      if (absenceReversals >= MAX_ABSENCE_REVERSALS) {
        missingMeansDrafted = false;
        addLog(`Two wrong calls: no longer marking players drafted just because a sweep can't find them. Use "I drafted this player" if the board looks stale.`);
        return;
      }
    }
  }
  function restingUnconfirmed(name) {
    return unconfirmed.resting(name);
  }

  /* The fullest sweep this page has managed, as the yardstick for whether a
   * later one is complete enough to mark players drafted from absence. */
  let bestSweepSeen = 0;
  // Once per page, not once per turn: it is the same advice every time.
  let warnedHiddenTurn = false;
  // Same reasoning: the configuration is either right or wrong, and repeating
  // it every four seconds would bury everything else in the log.
  let warnedTeamCount = false;
  /* Said once, then shown continuously. A log line about a degraded panel
   * scrolls out of view in a busy draft, which is precisely when it matters. */
  let saidHidden = false;
  /* Appended to the version in the panel header, where it stays visible for
   * as long as it is true. */
  let headerState = "";
  function setHeaderState(state) {
    if (state === headerState) return;
    headerState = state;
    try {
      const el = root.querySelector("#fm-ver");
      const version = `v${chrome.runtime.getManifest().version}`;
      el.textContent = state ? `${version} — ${state}` : version;
      el.classList.toggle("degraded", Boolean(state));
    } catch {
      // Context gone; handleDeadContext covers it.
    }
  }

  /* Said when the list stops responding to scrolling, whatever the cause —
   * a covered window, a discarded tab, a room mid-rerender. Describes the
   * symptom rather than guessing at the reason, because the reason was
   * guessed wrong once already. */
  function noteFrozen() {
    setHeaderState("degraded — list not rendering");
    if (saidHidden) return;
    saidHidden = true;
    addLog("The player list stopped rendering while being read — usually a covered or backgrounded window. Keeping the queue deeper instead; Yahoo drafts from it either way.");
  }


  /* How many players the board still believes are available. Marking from
   * absence is measured against this rather than a flat row count. It only
   * ever shrinks, and a stale value is therefore too large, which makes
   * marking harder — the safe direction. */
  function availableOnBoard() {
    return (boardPlayers || []).filter((p) => !p.draftedBy).length;
  }

  /* May a sweep conclude that a player it did not see has been drafted? The
   * rule and the reasoning behind it live in src/lib/sweepTrust.js, where
   * they are unit tested; both callers here go through it so the two cannot
   * drift apart again. */
  function sweepCanMarkMissing(seenCount, reachedEnd) {
    /* The room has stated which players are drafted, so there is nothing for
     * an inference from absence to contribute — and every way it has gone
     * wrong is still available to it. */
    if (resultsAuthoritative) return false;
    const trust = sweepTrust(seenCount, reachedEnd, availableOnBoard(), bestSweepSeen);
    bestSweepSeen = trust.best;
    return trust.mark;
  }

  async function locatePlayer(name, meta, { keepScroll = false } = {}) {
    let el = findPlayerClickTarget(document.body, name, { player: meta });
    if (el) return { el, searchBox: null, searched: false, filtered: false };

    /* Scroll the list to find him rather than typing in the room's search box.
     *
     * Searching cost five seconds a miss, left filters behind that narrowed
     * every later lookup, and changed what the user was looking at mid-draft.
     * Scrolling touches nothing: the rows are already there, just not all
     * rendered at once.
     *
     * It also gives a better answer about absence. A completed sweep has seen
     * the whole list, so "not found" means not in it — provided the sweep
     * really did cover the board, which is what the name count checks. A
     * filtered list would otherwise make everyone outside the filter look
     * drafted. */
    let found = null;
    let sawName = false;
    let sweep = { reachedEnd: false };
    const seen = new Set();
    /* One row carrying his abbreviation is him. findPlayerClickTarget also
     * demands the row show his team, which is there to separate two players
     * with the same abbreviation — and when only one row on screen carries
     * it, there is nothing to separate. That check was rejecting real rows
     * wherever our imported pool's team disagreed with the room's, leaving
     * the panel to report "couldn't confirm Chase Brown" indefinitely. */
    const abbrev = `${name.trim()[0]}. ${surnameOf(name)}`;
    const abbrevRe = new RegExp(
      `(?<!\\w)${abbrev.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?!\\w)`, "i"
    );
    const onlyRowFor = () => {
      const rows = [...document.querySelectorAll("tbody tr")].filter((tr) =>
        abbrevRe.test(tr.innerText || "")
      );
      return rows.length === 1 ? rows[0].querySelector("td:nth-child(2)") || rows[0] : null;
    };
    detectionSuspended = true;
    try {
      sweep = await sweepList((text) => {
        if (!found) found = findPlayerClickTarget(document.body, name, { player: meta }) || onlyRowFor();
        // Identifying him and merely seeing his name are different questions.
        // The click target insists the row shows his team, which fails when
        // our pool disagrees with the room — and without this, that turned
        // into "drafted", in a waiting room where nothing had been drafted.
        if (!sawName && nameAppears(name, text)) sawName = true;
        if (boardNameSet) {
          for (const n of findBoardNames(text, boardNameSet, boardPlayers)) seen.add(n);
        }
      }, { restore: !keepScroll });
    } finally {
      detectionSuspended = false;
      previousBoardNames = null;
      previousScrollTop = null;
    }

    /* The same rule the board repair uses. This path is the one that actually
     * writes phantom picks — it marks the player drafted outright — so it gets
     * the stricter reading of absence, not a looser one. */
    const sawWholeBoard = sweepCanMarkMissing(seen.size, sweep.reachedEnd);
    return {
      el: found,
      searchBox: null,
      searched: true,
      filtered: !found && sawWholeBoard && !sawName,
      /* The same bar as marking, not the weaker one used for freeing.
       *
       * This was the freeing threshold, on the reasoning that three partial
       * views are worth one complete one. They are not. A sweep that reads
       * 57% of the board reads much the same 57% every time — the rows it
       * cannot reach are the rows it cannot reach — so three misses of a
       * systematically unseen region is one miss repeated, and repetition is
       * only evidence when the observations are independent. A live draft
       * marked Marvin Harrison Jr., Jameson Williams, Brandon Aubrey and
       * Ka'imi Fairbairn drafted on that basis, all still available, one line
       * after the board refresh had refused to mark anyone at all from the
       * very same view. */
      sawList: sawWholeBoard,
    };
  }

  async function closeSearch(box) {
    /* Find the box ourselves when the caller has none. A lookup that didn't
     * need to search returns null, and assigning that over the previous
     * handle lost the only reference to a filter still sitting in the room —
     * so it stayed, and every later lookup searched a list narrowed to
     * somebody else. */
    const searchBox = box || (searchWeTyped ? findPlayerSearchBox(document.body) : null);
    if (!searchBox) return;
    searchWeTyped = null;
    setInputValue(searchBox, "");
    await wait(400);
    previousBoardNames = null;
    previousScrollTop = null; // the filtered page was never a real board
    detectionSuspended = false;
  }

  /* A recommendation for someone already drafted is the single most common
   * way this panel is wrong: picks made off-screen are unobservable, so the
   * board goes on offering players who left the pool rounds ago.
   *
   * Searching the room for them answers it directly. If the room cannot
   * produce the player, he is gone — record that and ask the engine for its
   * next choice, rather than reporting failure and stopping. */
  async function resolveAvailableRecommendation(maxSkips = 4) {
    let searchBox = null;
    let skipped = 0;
    /* Candidates that can't be confirmed either way on this pass.
     *
     * A player queued in the room is pulled out of its available list, so he
     * has no row and no Draft button — while his name is still on the page,
     * in the queue panel, so he can't be called drafted either. Without
     * setting him aside he stays the recommendation for ever and every turn
     * deadlocks on him. Seen live: Cam Ward, at pick 180, with the panel
     * reporting "couldn't find Cam Ward" while his name was on the page. */
    const unusable = new Set();

    for (let attempt = 0; attempt <= maxSkips; attempt++) {
      const snapshot = await sendMessage({ type: "GET_SNAPSHOT", picksUntilTurn, teams: detectedTeams, format: detectedFormat, exclude: unconfirmed.restingKeys() });
      const shortlist = await sendMessage({ type: "GET_SHORTLIST", n: maxSkips + 2, picksUntilTurn, teams: detectedTeams, format: detectedFormat, exclude: unconfirmed.restingKeys() });
      /* Skip what is resting as well as what this turn has already ruled
       * out, so a name the room would not produce a moment ago doesn't cost
       * another walk of the list now. */
      const candidate = shortlist.find(
        (p) => !unusable.has(p.name) && !restingUnconfirmed(p.name)
      );
      if (!candidate) {
        return { snapshot, name: null, el: null, searchBox, skipped, exhausted: true };
      }

      /* The room's own designation decides, whatever the board thinks. An IR
       * player was drafted at a turn because this check existed only in the
       * queue path — so a player the queue would refuse to star could still
       * be pressed straight into the roster. */
      if (looksUnavailableOnPage(document.body, candidate.name) ||
          rowShowsNoAdp(document.body, candidate.name)) {
        addLog(`${candidate.name} is listed out in this room — taking the next name.`);
        unusable.add(candidate.name);
        continue;
      }

      const meta = (boardPlayers || []).find((p) => p.name === candidate.name) || null;
      await closeSearch(searchBox);
      const located = await locatePlayer(candidate.name, meta, { keepScroll: true });
      searchBox = located.searchBox || searchBox; // never lose the handle
      if (located.el) {
        unconfirmed.succeed(candidate.name); // found him: no longer suspect
        return { snapshot, name: candidate.name, el: located.el, searchBox, skipped, exhausted: false };
      }

      if (located.filtered) {
        addLog(`${candidate.name} isn't in this room any more — marking drafted and taking the next name.`);
        await sendMessage({ type: "IMPORT_PICKS", names: [candidate.name], by: "rival" });
        skipped++;
      } else {
        // Can't confirm him either way: change nothing, but don't stall here,
        // and put it on the same ledger the queue uses. A name the room will
        // not produce is not worth a full sweep of the list at every turn as
        // well as every queue cycle.
        unusable.add(candidate.name);
        noteUnconfirmed(candidate.name, located.sawList);
      }
    }
    return { snapshot: null, name: null, el: null, searchBox, skipped, exhausted: true };
  }

  Storage.getQueueEnabled().then((on) => { queueEnabled = on; queueBox.checked = on; });
  queueBox.addEventListener("change", async () => {
    queueEnabled = queueBox.checked;
    await Storage.setQueueEnabled(queueEnabled);
    addLog(queueEnabled
      ? `Keeping Yahoo's queue ${QUEUE_DEPTH} deep — it drafts for you even if this tab is asleep.`
      : "Leaving Yahoo's queue alone.");
    if (queueEnabled) lastQueueRunAt = 0;
  });

  /* Maintain the room's queue between picks. Everything fiddly — searching,
   * scrolling, clicking — happens here, off the clock, where a failure costs
   * a retry instead of a pick. */
  /* Say it again after a while. Once-per-reason-forever meant a cycle that
   * had explained itself early went permanently silent, and "it isn't
   * queueing anyone" then had no answer anywhere in the panel — which is
   * exactly the position this left us in during a live draft. */
  const queueNotes = new Map();
  function noteQueueIdle(message) {
    const last = queueNotes.get(message) || 0;
    if (Date.now() - last < 60000) return;
    queueNotes.set(message, Date.now());
    addLog(message);
  }

  async function maintainQueue(text) {
    if (!queueEnabled) return;

    /* Report which guard stopped the cycle. Every silent early return in here
     * has cost a round of guessing from outside the panel — three times now —
     * so each one says its own name, once a minute. */
    if (detectionSuspended) return noteQueueIdle("queue: waiting — the page is being swept");
    if (Date.now() - lastQueueRunAt < 15000) return;
    if (turnBannerPresent()) return noteQueueIdle("queue: waiting — it's your turn");
    if (roomBusy) return noteQueueIdle("queue: waiting — a board update is using the search");
    lastQueueRunAt = Date.now();

    /* Waiting for a refresh that cannot happen is worse than working from a
     * stale board.
     *
     * This gate existed so the queue never stars players from an out-of-date
     * board. But when the refresh is impossible rather than merely late — a
     * hidden tab, where sweeps are skipped because rendering is suspended, or
     * a room showing anything but its Players list — the gate never lifts,
     * and a live draft spent twenty minutes logging this same line while
     * Yahoo drafted the whole roster on its own rankings. Keeping the queue
     * full is the entire mitigation for an unattended turn; blocking it
     * because the board might be stale gets the trade exactly backwards. */
    if (Date.now() - lastBoardUpdateAt > BOARD_REFRESH_MS) {
      if (!boardRefreshBlocked) {
        noteQueueIdle("queue: waiting for the board refresh to finish");
        return;
      }
      noteQueueIdle("queue: can't refresh the board here, so queueing from the board as it stands — an empty queue is worse than a stale one.");
    }

    if (!boardNameSet) return noteQueueIdle("queue: waiting — the board hasn't loaded yet");

    /* The star column and the Draft buttons exist only in the room's Players
     * list. With another tab showing — Board, Picks, Results — there is
     * nothing to click, and the panel was reporting that as a missing star on
     * a particular player's row, which points at the wrong thing entirely. */
    if (document.querySelectorAll('[data-icon*="star" i]').length < 5) {
      return noteQueueIdle("queue: open the room's Players tab — nothing to star while it's hidden");
    }

    /* A filter in the room's search box narrows the list to a handful of
     * players, and then nothing else can be found — reported one name at a
     * time as "couldn't confirm". Clearing only our own text wasn't enough:
     * a filter left from an earlier session isn't ours by record and stayed
     * forever. With fully-automatic on the user has handed the pick over, so
     * clear it and say so; otherwise ask, rather than wiping their typing. */
    const box = findPlayerSearchBox(document.body);
    if (box?.value) {
      if (autoFullBox.checked) {
        addLog(`Cleared "${box.value}" from the room's search so the whole list is visible.`);
        setInputValue(box, "");
        searchWeTyped = null;
        previousBoardNames = null;
        previousScrollTop = null;
        await wait(500);
      } else {
        return noteQueueIdle(`queue: the room's search box has "${box.value}" in it — clear it to see the full list`);
      }
    }
    const inRoom = findQueueNames(text, boardNameSet, boardPlayers);
    if (inRoom === null) {
      noteQueueIdle("queue: can't see the queue panel — open the Queue tab in the left column");
      return;
    }

    // Anything we queued that the room no longer lists was drafted by someone.
    const vanished = [...queuedByUs].filter((name) => !inRoom.has(name));
    if (vanished.length > 0) {
      for (const name of vanished) queuedByUs.delete(name);
      const { changed } = await sendMessage({ type: "IMPORT_PICKS", names: vanished, by: "rival" });
      if (changed) addLog(`Gone from the queue, so drafted: ${vanished.join(", ")}`);
    }

    /* Add two per cycle — this shares a page with a live draft, and a long
     * scripted burst of searching and clicking is its own hazard. But a
     * player who turns out to be drafted costs nothing to skip, so those
     * don't consume the budget: against a stale board the whole cycle would
     * otherwise be spent marking two players gone and queueing nobody, which
     * is exactly what it did in testing. */
    let searchBox = null;
    let added = 0;
    let attempts = 0;
    /* Candidates this cycle has already failed to confirm. One player the
     * room won't confirm used to end the cycle, so a single awkward name
     * blocked the queue entirely. */
    const tried = new Set();
    roomBusy = true;
    try {
      while (added < 2 && attempts < 8) {
        attempts++;
        if (attempts === 1) {
          noteQueueIdle(`queue: checking — ${inRoom.size} in the room's queue`);
        }
        /* Take out what no longer belongs. Yahoo drafts from this queue, so an
     * entry left there is a pick waiting to happen — and entries added before
     * the roster changed are how a team ended up with three tight ends and
     * two quarterbacks. Only players the shortlist no longer wants at all,
     * one per cycle, so a queue the user curated isn't emptied underneath
     * them. */
    const shortlistNow = await sendMessage({ type: "GET_SHORTLIST", n: queueDepth(), picksUntilTurn, teams: detectedTeams, format: detectedFormat, exclude: unconfirmed.restingKeys() });
    const keep = new Set(shortlistNow.map((p) => p.name));
    const stale = [...inRoom].filter((name) => !keep.has(name));
    if (stale.length > 0) {
      const name = stale[0];
      const control = findQueueRemove(document.body, name);
      if (control) {
        clickElement(control);
        queuedByUs.delete(name);
        addLog(`Took ${name} out of the queue — no longer in the shortlist.`);
        await wait(600);
        return; // re-read the queue next cycle rather than acting on stale counts
      }
    }

    const wanted = shortlistNow;
        const pick = wanted.find(
          (p) => !inRoom.has(p.name) && !queuedByUs.has(p.name) && !tried.has(p.name) &&
            !restingUnconfirmed(p.name)
        );
        if (!pick) {
          if (attempts === 1) noteQueueIdle(wanted.length === 0
            ? "queue: board has no available players — rebuild it from Yahoo's list"
            : "queue: already holds the shortlist");
          break;
        }

        const meta = (boardPlayers || []).find((p) => p.name === pick.name) || null;
        await closeSearch(searchBox);
        const located = await locatePlayer(pick.name, meta);
        searchBox = located.searchBox || searchBox; // never lose the handle
        if (!located.el) {
          if (!located.filtered) {
            // Couldn't confirm him either way: don't touch the board, and try
            // the next name rather than ending the cycle.
            tried.add(pick.name);
            noteUnconfirmed(pick.name, located.sawList);
            noteQueueIdle(`queue: couldn't confirm ${pick.name} in the room — trying the next name`);
            continue;
          }
          // The room can't produce him: he's drafted. Same reasoning the
          // recommendation resolver uses. Doesn't count against the budget.
          await sendMessage({ type: "IMPORT_PICKS", names: [pick.name], by: "rival" });
          addLog(`${pick.name} isn't in the room — marking drafted.`);
          continue;
        }
        if (rowShowsNoAdp(document.body, pick.name)) {
          // Nobody in the league drafts him; a queued pick would be wasted.
          tried.add(pick.name);
          noteQueueIdle(`queue: ${pick.name} has no ADP in this room — skipping him`);
          continue;
        }
        if (looksUnavailableOnPage(document.body, pick.name)) {
          // The room says he isn't playing, whatever our board thinks.
          tried.add(pick.name);
          noteQueueIdle(`queue: ${pick.name} is listed out — skipping him`);
          continue;
        }
        const star = findQueueStar(document.body, pick.name, { player: meta });
        if (!star) {
          tried.add(pick.name);
          /* His name is on the page with no row behind it: he is drafted, and
           * the ledger is where that goes. Anything else is a real failure to
           * find the control, and stays a nudge. */
          if (explainMissingControl(pick.name, meta, "star")) {
            noteUnconfirmed(pick.name, true);
          } else {
            noteQueueIdle(`queue: found ${pick.name} but no star on his row — trying the next name`);
          }
          continue;
        }
        clickElement(star);
        await wait(600);
        queuedByUs.add(pick.name);
        added++;
        addLog(`Queued ${pick.name}.`);
      }
    } finally {
      await closeSearch(searchBox);
      roomBusy = false;
    }
  }

  /* The list Yahoo shows is the available players. Sweeping it and treating
   * the rest as drafted replaces every inference in this file with Yahoo's
   * own state — and repairs a board that has drifted, which nothing else here
   * can do: detection only ever adds picks, so once a player is wrongly
   * marked drafted he never comes back. */

  /* One action rather than three. Sync, rebuild and verify were three ways of
   * answering "what does this room actually know", and the differences between
   * them were ours, not the user's — with the worst of it being that Sync read
   * the same list as picks rather than as availability, and so could mark a
   * hundred available players drafted.
   *
   * Read the list, set the board to match it, then confirm the recommendation
   * that comes out is a player the room can still produce. */
  /* The sweep is the only thing that makes the board true, and leaving it to
   * a button meant it was pressed once at the start and never again — so the
   * shortlist went stale within a round or two and queue maintenance spent
   * every cycle marking drafted players instead of queueing anyone. Run it on
   * a timer as well, between picks, where it costs nothing. */
  let lastBoardUpdateAt = 0;
  async function updateBoardFromRoom({ verify }) {
    const searchBox = findPlayerSearchBox(document.body);
    if (searchBox && searchBox.value) {
      setInputValue(searchBox, "");
      await wait(700);
    }
    const scroller = findListScroller(document.body);
    if (!scroller) return { ok: false, reason: "no player list on this page" };

    // Always fresh here: the count of still-available players is what decides
    // whether this sweep is complete enough to rewrite the board with, and a
    // stale copy would answer that question about an older draft.
    const snap = await sendMessage({ type: "GET_SNAPSHOT" });
    boardNameSet = new Set(snap.board.map((p) => p.name));
    boardPlayers = snap.board;

    /* How many the board expects to still be available. A sweep that sees far
     * fewer than that did not cover the list, and repairing from it marks
     * everyone it missed as drafted. Watched a refresh put 208 players back
     * that an earlier partial sweep had wrongly buried — and while the board
     * was in that state the queue had nothing good left to offer, which is
     * where a D-grade receiver came from. */
    const expected = snap.board.filter((p) => !p.draftedBy).length;

    let sweep = { reachedEnd: false };
    const seen = new Set();
    /* Collect ADP while we're already walking every row. Names come back as
     * the room writes them, so each is resolved against the board with the
     * matcher that handles abbreviations, and anything ambiguous is dropped
     * rather than guessed at. */
    const adpByBoardName = {};
    const projByBoardName = {};
    const statusByBoardName = {};
    detectionSuspended = true;
    try {
      sweep = await sweepList(() => {
        for (const name of findBoardNames(scroller.innerText, boardNameSet, boardPlayers)) {
          seen.add(name);
        }
        for (const [label, adp] of readRoomAdp(document.body)) {
          const resolved = findBoardNames(label, boardNameSet, boardPlayers);
          if (resolved.size === 1) adpByBoardName[[...resolved][0]] = adp;
        }
        // The same walk, one more column: projected points, which is what
        // makes a tier cliff measurable without any projections provider.
        for (const [label, proj] of readRoomProjections(document.body)) {
          const resolved = findBoardNames(label, boardNameSet, boardPlayers);
          if (resolved.size === 1) projByBoardName[[...resolved][0]] = proj;
        }
        for (const [label, status] of readRoomStatuses(document.body)) {
          const resolved = findBoardNames(label, boardNameSet, boardPlayers);
          if (resolved.size === 1) statusByBoardName[[...resolved][0]] = status;
        }
      });
    } finally {
      detectionSuspended = false;
      previousBoardNames = null;
      previousScrollTop = null;
    }

    if (!sweepTrust(seen.size, sweep.reachedEnd, expected, bestSweepSeen).free) {
      return {
        ok: false,
        reason: `only ${seen.size} of about ${expected} available players read — too few to rewrite the board`,
      };
    }

    /* Marking from absence needs a sweep as complete as the best one yet.
     *
     * How much of the list a sweep reaches varies with scroll timing and how
     * fast the room re-renders, so consecutive sweeps see different subsets —
     * and since the repair marks everything it didn't see as drafted, the
     * board flip-flops: one refresh reported 147 players put back that an
     * earlier one had buried. While they were buried the queue had nothing
     * good to offer, which is where the D-grade picks came from.
     *
     * So a sweep only rewrites what it missed if it is within reach of the
     * fullest view we have managed. A thinner one may still free players it
     * saw — that direction cannot invent a pick. */
    const complete = sweepCanMarkMissing(seen.size, sweep.reachedEnd);
    const result = await sendMessage({
      type: "REPAIR_BOARD",
      names: [...seen],
      markMissing: complete,
    });
    lastBoardUpdateAt = Date.now();
    checkAbsenceRule(result.freedNames);
    if (!complete) {
      addLog(`Partial view (${seen.size} seen, board has ${availableOnBoard()} available) — freeing only, not marking.`);
    }

    const outCount = Object.keys(statusByBoardName).length;
    if (outCount > 0) {
      const statusResult = await sendMessage({
        type: "RECORD_ROOM_STATUS",
        entries: statusByBoardName,
      });
      if (statusResult.changed > 0) {
        addLog(`Marked ${statusResult.changed} players as out (IR/NA/PUP) from the room.`);
      }
    }

    const adpCount = Object.keys(adpByBoardName).length;
    if (adpCount > 0) {
      const adpResult = await sendMessage({ type: "RECORD_ROOM_ADP", entries: adpByBoardName });
      if (adpResult.changed > 0) {
        addLog(`Read ADP for ${adpResult.changed} players from the room (${adpResult.total} known).`);
      }
    }

    const projCount = Object.keys(projByBoardName).length;
    if (projCount > 0) {
      const projResult = await sendMessage({
        type: "RECORD_ROOM_PROJECTION", entries: projByBoardName,
      });
      if (projResult.changed > 0) {
        addLog(`Read projected points for ${projResult.changed} players from the room.`);
      }
    }

    if (!verify) return { ok: true, result };
    const resolved = await resolveAvailableRecommendation(10);
    await closeSearch(resolved.searchBox);
    return { ok: true, result, resolved };
  }

  updateBtn.addEventListener("click", async () => {
    if (updateBtn.disabled) return;
    updateBtn.disabled = true;
    const label = updateBtn.textContent;
    const wasBusy = roomBusy;
    roomBusy = true;
    try {
      if (wasBusy) {
        addLog("Queue maintenance is using the search — try again in a few seconds.");
        return;
      }
      updateBtn.textContent = "Reading Yahoo's list\u2026";
      const out = await updateBoardFromRoom({ verify: true });
      if (!out.ok) {
        addLog(`Board not updated: ${out.reason}.`);
        return;
      }
      addLog(`Board updated: ${out.result.seen} available, ${out.result.markedDrafted} newly drafted, ${out.result.freed} put back.`);
      updateBtn.classList.remove("stale");
      if (out.resolved?.el) {
        addLog(out.resolved.skipped > 0
          ? `Recommending ${out.resolved.name} — skipped ${out.resolved.skipped} already gone.`
          : `Recommending ${out.resolved.name}.`);
      }
      await refresh();
    } catch (err) {
      if (detectionSuspended) {
        detectionSuspended = false;
        previousBoardNames = null;
        previousScrollTop = null;
      }
      if (isContextGone(err)) return handleDeadContext();
      showError(String(err.message || err));
    } finally {
      roomBusy = false;
      updateBtn.disabled = false;
      updateBtn.textContent = label;
    }
  });

  /* Replace the bundled board with the league's own player list. The shipped
   * file is a pre-season snapshot and is wrong in ways nothing downstream can
   * repair — both Robinsons on Atlanta, so "B. Robinson" can never be
   * resolved. Yahoo's list has current teams, positions and byes. */
  poolBtn.addEventListener("click", async () => {
    if (poolBtn.disabled) return;
    poolBtn.disabled = true;
    const label = poolBtn.textContent;
    poolBtn.textContent = "Reading Yahoo's player list\u2026";
    try {
      /* Consensus ADP first, and unconditionally: it comes from outside Yahoo
       * and needs no league at all. Nesting it inside the pool import meant a
       * page without a league id in its address — a draft room reached from
       * the lobby, say — skipped the ADP too, and the board went on ordering
       * players by their position in a list. */
      try {
        const adp = await sendMessage({ type: "REFRESH_CONSENSUS_ADP" });
        addLog(adp.ok
          ? `Consensus ADP loaded for ${adp.count} players.`
          : `Consensus ADP looked wrong (${adp.count} players) — keeping what we had.`);
      } catch (err) {
        addLog(`Couldn't load consensus ADP: ${String(err.message || err)}`);
      }

      /* The player pool does need one. Fall back to the league imported last
       * time, since a draft room's own id has no players page behind it. */
      const stored = await Storage.getPool();
      const leagueId = leagueIdFromUrl(location.href) || stored?.leagueId || null;
      if (!leagueId) {
        addLog("Players not imported: no league id here, and none remembered. Open your league's Players page.");
        await refresh();
        return;
      }
      const get = (url) =>
        new Promise((res, rej) => {
          const req = new XMLHttpRequest();
          req.open("GET", url, true);
          req.onload = () => res(req.responseText);
          req.onerror = () => rej(new Error(`couldn't read ${url}`));
          req.send();
        });
      const players = await fetchPool(leagueId, { get, pages: 12 });
      if (players.length < 100) {
        // A short read means the page wasn't what we expected; the bundled
        // board is stale but coherent, and half a pool is worse than either.
        addLog(`Only read ${players.length} players — keeping the existing board.`);
        return;
      }
      await Storage.setPool({ fetchedAt: Date.now(), leagueId, players });
      boardNameSet = null;
      boardPlayers = null;
      previousBoardNames = null;
      previousScrollTop = null;
      addLog(`Imported ${players.length} players from Yahoo — the board is now the league's own list.`);
      await refresh();
    } catch (err) {
      if (isContextGone(err)) return handleDeadContext();
      showError(String(err.message || err));
    } finally {
      poolBtn.disabled = false;
      poolBtn.textContent = label;
    }
  });

  /* Report where the user picks and when their next turn lands. Queue depth
   * should follow from that — five is arbitrary, while "you pick again in
   * nineteen" is a real number — but for now it is reported rather than
   * acted on. */
  let lastPicksAway = null;
  let picksUntilTurn = null;
  let lastDraftPosition = null;
  let detectedTeams = null;
  let detectedFormat = null;
  function reportDraftPosition(text, config) {
    if (!parseDraftSlot) return;
    const slot = parseDraftSlot(location.href, document.title);
    const teams = detectedTeams ?? config?.league?.num_teams;
    const position = parseDraftPosition(text);
    if (!slot || !teams || !position) return;

    /* A configured team count that the room contradicts makes every pick
     * calculation wrong — how far away your turn is, and with it the endgame
     * reservation that fills the kicker and defence slots — and nothing else
     * in the panel would notice. The round and pick on screen bound the real
     * count, so check it against the configuration once. */
    /* The room's own team count, taken over the configured one.
     *
     * Not written back to settings: a mock room is twelve teams while the
     * league it is practising for is ten, so persisting what a mock says
     * would corrupt the real league's configuration. It applies for this
     * session only, the same way practice settings do. */
    const detected = teamsFromRoundChange(lastDraftPosition, position);
    lastDraftPosition = position;
    if (detected && detected !== detectedTeams) {
      detectedTeams = detected;
      Storage.setRoomFacts(roomId, { teams: detected }).catch(() => {});
      if (detected !== teams) {
        addLog(`This room has ${detected} teams, not the ${teams} in your settings — using ${detected} for every pick calculation from here. Change it in Options to make it stick.`);
      } else {
        addLog(`Confirmed ${detected} teams from the round change.`);
      }
    }

    const bounds = teamCountBounds(position);
    if (bounds && (teams < bounds.min || teams > bounds.max) && !warnedTeamCount) {
      warnedTeamCount = true;
      const range = bounds.max === Infinity ? `${bounds.min} or more` : `${bounds.min}-${bounds.max}`;
      addLog(`This room looks like a ${range} team draft, but the panel is set to ${teams}. Fix it in Options or every "picks away" number is wrong.`);
    }

    const away = picksUntilMyTurn(position, slot, teams);
    if (away === null || away === lastPicksAway) return;
    lastPicksAway = away;
    picksUntilTurn = away; // the engine can't derive this: it needs the slot and the snake
    if (away === 0) return; // the turn banner already covers this
    addLog(`Pick ${slot} of ${teams} — your next turn is ${away} pick${away === 1 ? "" : "s"} away.`);
  }

  /* Yahoo's own statement of what has been drafted, taken over every
   * inference the panel can make.
   *
   * The results and roster views list picks by full name with a round and a
   * pick number. That is the same question the sweeps have been answering
   * badly all along — who is gone — except stated rather than deduced, with
   * no abbreviation to resolve and nothing concluded from silence. When it is
   * on the page, it wins: absence-marking is skipped entirely for that cycle,
   * because there is nothing left for it to add.
   *
   * Ownership still comes from the roster panel. This says a player is drafted,
   * not whose he is, and importPicks lets "mine" outrank a "rival" recorded
   * earlier — so reading these as rivals' picks and correcting our own from
   * the roster is the right order. */
  const resultsSeen = new Set();
  let resultsAuthoritative = false;

  async function importDraftResults(text) {
    if (!parseDraftResults) return 0;
    const picks = parseDraftResults(text);
    if (picks.length === 0) {
      resultsAuthoritative = false;
      return 0;
    }
    resultsAuthoritative = true;

    const fresh = picks.filter((pick) => !resultsSeen.has(pick.name));
    for (const pick of fresh) resultsSeen.add(pick.name);
    if (fresh.length === 0) return picks.length;

    const known = fresh.filter((pick) => !boardNameSet || boardNameSet.has(pick.name));
    if (known.length > 0) {
      await sendMessage({
        type: "IMPORT_PICKS", names: known.map((p) => p.name), by: "rival",
      });
    }
    /* Named individually rather than counted, because a name here that the
     * board does not recognise is a join failure worth seeing — the room
     * spells him one way and our sources another. */
    const unknown = fresh.filter((pick) => boardNameSet && !boardNameSet.has(pick.name));
    if (unknown.length > 0) {
      addLog(`Room results name ${unknown.length} player(s) our board doesn't know: ${unknown.map((p) => p.name).join(", ")}`);
    }
    addLog(`Read ${fresh.length} pick(s) from the room's own results — ${picks.length} total, stated rather than inferred.`);
    return picks.length;
  }

  /* The pick the room just announced, taken as fact.
   *
   * This is the source everything else here has been a substitute for. The
   * board learned who was drafted by watching names leave a virtualised list,
   * which fails whenever the tab is throttled or the rows will not render —
   * and a draft reached round five still recommending four players who had
   * been gone for twenty picks, because nothing had told it otherwise. The
   * room says each pick out loud, with the position and team that separate
   * two players sharing an abbreviation.
   *
   * Recorded as a rival's, since the announcement does not say whose it is;
   * the roster panel corrects our own, and "mine" outranks "rival". */
  let lastAnnounced = null;
  async function importAnnouncedPick(text) {
    if (!parseLastPick || !boardNameSet) return;
    const last = parseLastPick(text);
    if (!last || last.block === lastAnnounced) return;
    lastAnnounced = last.block;

    const names = findBoardNames(last.block, boardNameSet, boardPlayers);
    if (names.size === 1) {
      const [name] = [...names];
      const { changed } = await sendMessage({
        type: "IMPORT_PICKS", names: [name], by: "rival",
      });
      if (changed) addLog(`Room announced ${name} drafted.`);
      return;
    }
    /* Said once per player rather than counted: a name the room announces and
     * the board cannot place is a join failure, and it is the difference
     * between a board that keeps up and one that quietly falls behind. */
    addLog(`Room announced ${last.label} (${last.pos} · ${last.team}) — couldn't match him to the board.`);
  }

  async function importMyTeam(text) {
    if (!boardNameSet || !findMyTeamNames) return false;
    const mine = [...findMyTeamNames(text, boardNameSet, boardPlayers)];
    if (mine.length === 0) return false;
    const { changed } = await sendMessage({ type: "IMPORT_PICKS", names: mine, by: "mine" });
    if (changed) addLog(`Read your team off the page: ${mine.join(", ")}`);
    return changed;
  }

  /* Cold start. Detection only ever sees changes from the moment it starts
   * watching, so a panel loaded — or reloaded — mid-draft believes every
   * player taken before then is still available, and will happily recommend
   * someone drafted in round one. This sweeps up whatever the page shows
   * right now, which is why the room's own Results/Picks view is worth
   * opening first. */
  /* Walk the whole scrolling list, not the dozen rows on screen. Everything
   * seen is collected; nothing is inferred from absence, so a sweep that
   * misses rows records less rather than something false. */
  async function sweepList(collect, { restore = true } = {}) {
    const scroller = findListScroller(document.body);
    collect(document.body.innerText);
    if (!scroller) return { scrolled: false, steps: 0 };

    /* Whether the list is rendering, tested rather than assumed.
     *
     * This used to refuse to sweep whenever document.hidden was true. That is
     * the wrong signal: Chrome reports a tab hidden when its window is merely
     * covered by another window, so a draft nobody had navigated away from
     * spent itself flagged "degraded — tab hidden" while sitting in plain
     * sight behind something else.
     *
     * What actually matters is whether scrolling reveals new rows, and that
     * can simply be checked. The walk below stops early if two consecutive
     * steps reveal nothing new — which is what a frozen tab looks like, and
     * also what the end of a short list looks like, and both are reasons to
     * stop. */

    const startTop = scroller.scrollTop;
    const step = Math.max(200, scroller.clientHeight - 60);
    let steps = 0;
    let reachedEnd = false;
    let stale = 0;
    let lastHeight = -1;
    for (let top = 0; top <= scroller.scrollHeight && steps < 40; top += step, steps++) {
      scroller.scrollTop = top;
      await wait(160); // let the list render the rows it just revealed
      collect(document.body.innerText);

      /* Frozen only when the tab is hidden as well.
       *
       * This used to call it frozen on unchanged page text alone, and that
       * fires on a list which is rendering perfectly well — a short list, a
       * scroll step that overshoots, a scroller that is not the one being
       * measured. It abandoned sweeps on a visible page showing a hundred
       * rows, left the board stale, and had the panel reporting it could not
       * confirm players whose rows were on screen at the time.
       *
       * Unchanged text is only evidence of freezing when there is a reason to
       * expect freezing, so both have to hold. */
      const height = document.body.innerText.length;
      stale = height === lastHeight ? stale + 1 : 0;
      lastHeight = height;
      if (stale >= 2 && document.hidden) {
        noteFrozen();
        break;
      }

      if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2) {
        reachedEnd = true;
        // Walking the list to the bottom is the proof that it renders; that,
        // not the tab's visibility, is what clears the warning.
        if (headerState) {
          setHeaderState("");
          saidHidden = false;
        }
        break;
      }
    }
    /* Leave the list where it is when the caller intends to act on what it
     * found: restoring the scroll unmounts the very row it was looking for,
     * and the Draft button goes with it. That cost a pick — "no Draft button
     * on his row" for a player the sweep had just located. */
    if (restore) {
      scroller.scrollTop = startTop;
      await wait(120);
    }
    /* Whether the walk actually got to the bottom. Comparing one sweep's size
     * against earlier ones leaves a hole on a fresh page: the first sweep sets
     * the standard, so a partial one becomes the yardstick and marks players
     * drafted from a view that never covered the list. Reaching the end is a
     * fact about this sweep alone. */
    return { scrolled: true, steps, reachedEnd };
  }

  /* Keep the board current regardless of what else is enabled. Detection
   * only ever sees a pick if the name happens to be rendered when it looks,
   * so a board left to it alone drifts within a round or two — and every
   * recommendation after that is about players who are gone. This is the
   * only thing that reads the room's actual state, so it shouldn't have been
   * conditional on the queue being switched on. */
  const BOARD_REFRESH_MS = 120000;
  /* Open the room's Picks panel, read every pick out of it, and put the Queue
   * back.
   *
   * The announcement covers picks made while we are watching, and nothing
   * else: a reload, a throttled minute or a closed laptop leaves a permanent
   * hole, and this draft reached round thirteen still recommending Derrick
   * Henry, taken in round three. Sweeps cannot fill that hole either — a
   * partial view is not allowed to conclude anyone is drafted, correctly, and
   * a partial view is all a virtualised list gives.
   *
   * The room keeps the whole list and will show it on request. It is a
   * read-only view swap in the side panel, the player list is untouched
   * beneath it, and the Queue goes back immediately — but it does replace the
   * queue panel while it is open, so it never runs during a turn and never
   * while anything else is using the room. */
  let lastPicksSyncAt = 0;
  async function syncFromPicksPanel() {
    /* Disabled. Reading the Picks panel means swapping the side panel over
     * and swapping it back, and in a live draft it did not always swap back —
     * the room was left showing Picks, which is where queue maintenance reads
     * what is queued, so the panel spent the rest of the draft reporting it
     * could not see the queue. The idea is right and the board badly needs
     * this list; it does not go back in until it can confirm the Queue panel
     * is showing again afterwards, and put it back when it is not. */
    if (!PICKS_SYNC_ENABLED) return;
    if (!findPanelTab || !parseDraftResults) return;
    if (roomBusy || detectionSuspended || turnBannerPresent()) return;
    if (Date.now() - lastPicksSyncAt < PICKS_SYNC_MS) return;

    const picksTab = findPanelTab(document.body, "Picks");
    if (!picksTab) return;
    lastPicksSyncAt = Date.now();
    roomBusy = true;
    try {
      clickElement(picksTab);
      await wait(700); // the panel renders its list
      const picks = parseDraftResults(document.body.innerText);
      if (picks.length > 0) {
        const known = picks
          .map((pick) => pick.name)
          .filter((name) => !boardNameSet || boardNameSet.has(name));
        if (known.length > 0) {
          const { changed } = await sendMessage({
            type: "IMPORT_PICKS", names: known, by: "rival",
          });
          if (changed) {
            addLog(`Read ${picks.length} picks from the room's Picks panel — the board is caught up.`);
          }
        }
        const unknown = picks.length - known.length;
        if (unknown > 0) addLog(`${unknown} pick(s) in that list didn't match our board.`);
      }
    } catch (err) {
      if (isContextGone(err)) return handleDeadContext();
      addLog(`Couldn't read the Picks panel: ${String(err.message || err)}`);
    } finally {
      // Always put the queue back: leaving Picks showing would blind queue
      // maintenance for the rest of the draft.
      const queueTab = findPanelTab(document.body, "Queue");
      if (queueTab) {
        clickElement(queueTab);
        await wait(300);
      }
      roomBusy = false;
    }
  }

  async function maybeRefreshBoard() {
    if (roomBusy || detectionSuspended) return;
    if (Date.now() - lastBoardUpdateAt < BOARD_REFRESH_MS) return;
    if (turnBannerPresent()) return; // never scroll the list during your pick
    roomBusy = true;
    try {
      const out = await updateBoardFromRoom({ verify: false });
      /* Whether a refresh is currently achievable at all. A failure here is
       * usually not an error — it is the sweep correctly declining to trust a
       * view it could not take — but something downstream is waiting on it,
       * and needs to know the difference between late and impossible. */
      boardRefreshBlocked = !out.ok;
      if (out.ok) {
        addLog(`Board refreshed: ${out.result.seen} available, ${out.result.markedDrafted} newly drafted, ${out.result.freed} put back.`);
      }
    } catch (err) {
      if (isContextGone(err)) return handleDeadContext();
      addLog(`Board refresh failed: ${String(err.message || err)}`);
    } finally {
      roomBusy = false;
    }
  }

  async function pollPage() {
    if (!polling || detectionSuspended) return;

    /* Clear a filter we left behind — only ever text we typed ourselves, so a
     * search the user is running is never wiped from under them. */
    if (searchWeTyped && !roomBusy) {
      const box = findPlayerSearchBox(document.body);
      if (box && box.value === searchWeTyped) {
        setInputValue(box, "");
        addLog("Cleared a leftover player search.");
        previousBoardNames = null;
        previousScrollTop = null;
      }
      searchWeTyped = null;
    }

    /* Chrome throttles timers in a hidden tab to about once a minute, and
     * discards tabs outright under Memory Saver. Either way the poll simply
     * stops for a while, and picks made in that window are never seen — the
     * panel comes back looking healthy and quietly out of date. It can't
     * prevent that, but it can refuse to hide it. */
    /* Clear a degraded badge the moment the tab is genuinely visible. It was
     * set on a hidden sweep and only ever cleared by a visibilitychange
     * event, so a tab that was hidden when the script loaded kept the badge
     * for the rest of the draft. */
    const now = Date.now();
    const gap = now - lastPollAt;
    lastPollAt = now;
    if (gap > POLL_INTERVAL_MS * 3) {
      addLog(`Stopped watching for ${Math.round(gap / 1000)}s (tab was in the background?) — picks may have been missed. Re-sync.`);
      updateBtn.classList.add("stale");
    }

    try {
      if (!boardNameSet) {
        const snapshot = await sendMessage({ type: "GET_SNAPSHOT", picksUntilTurn, teams: detectedTeams, format: detectedFormat, exclude: unconfirmed.restingKeys() });
        boardNameSet = new Set(snapshot.board.map((p) => p.name));
        boardPlayers = snapshot.board;
      }
      const text = document.body.innerText;
      await importDraftResults(text);
      await importAnnouncedPick(text);
      await importMyTeam(text);
      checkRosterShape(text, lastConfig);
      reportDraftPosition(text, lastConfig);
      await maybeRefreshBoard();
      await maintainQueue(text);
      // Not the queue panel: a name we queued is not a name that was drafted.
      const detectText = withoutQueuePanel(text);
      const found = findBoardNames(detectText, boardNameSet, boardPlayers);

      // Say it once per name: a pick this can't attribute is a hole in the
      // board, and the fix is one manual click in the popup.
      for (const abbrev of findAmbiguousAbbrevs(detectText, boardNameSet, boardPlayers)) {
        if (reportedAmbiguous.has(abbrev)) continue;
        reportedAmbiguous.add(abbrev);
        addLog(`"${abbrev}" matches two players — mark it by hand if it was drafted.`);
      }

      /* An unknown scroll position is not a matching one. When the list
       * scroller cannot be found, both samples record null, and null === null
       * let the comparison through with no idea whether the view had moved —
       * which is how the same fourteen bottom-of-the-list players were
       * detected as drafted again after the fix meant to stop it. */
      const scrollNow = findListScroller(document.body)?.scrollTop ?? null;
      const sameView = scrollNow !== null && previousScrollTop === scrollNow;
      if (previousBoardNames && sameView) {
        // "appear": a picks feed — names show up as taken.
        // "disappear": an available-player pool — names leave it as taken.
        const newlyDrafted = inferDraftedFromPoll(previousBoardNames, found, modeSelect.value);
        /* A backstop that does not depend on spotting the scroll at all.
         *
         * Polls are four seconds apart and a room drafts one player at a
         * time, so a handful of names changing at once is a draft and a dozen
         * is the page showing something else. Every version of this bug has
         * arrived as a burst — fourteen names, seventeen names — and every
         * real detection has been one or two. Whatever the cause, a burst is
         * never evidence of a burst of picks. */
        if (newlyDrafted.size > MAX_PICKS_PER_POLL) {
          noteQueueIdle(`Ignored ${newlyDrafted.size} players vanishing at once — that is the list moving, not ${newlyDrafted.size} picks.`);
        } else if (newlyDrafted.size > 0) {
          const names = [...newlyDrafted];
          const { changed } = await sendMessage({ type: "DETECTED_PICKS", names });
          if (changed) {
            for (const name of names) addLog(`Detected: ${name}`);
            await refresh();
          }
        }
      }
      previousBoardNames = found;
      previousScrollTop = scrollNow;
    } catch (err) {
      // A dead context is permanent and needs saying — silently retrying it
      // every few seconds is what made a reloaded extension look like a
      // working one that simply never noticed a pick.
      if (isContextGone(err)) return handleDeadContext();
      // Other poll errors stay silent: the panel just stops updating rather
      // than spamming errors on a page the user isn't actively drafting on.
    }
  }

  // Small random delay before any click so it doesn't fire the instant the
  // turn phrase appears — reduces the odds of racing a page that's still
  // rendering, not an attempt to disguise automated activity.
  function jitterDelay() {
    return 500 + Math.random() * 900;
  }
  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function pollForTurn() {
    // The same pause toggle that stops opponent-pick detection also stops
    // auto-draft — one pause button for everything this panel does
    // unattended, not two controls that could be confused for each other.
    if (!autoEnableBox.checked || !polling) return;
    try {
      const active = turnBannerPresent();

      if (!active) {
        turnActive = false;
        turnConfidence = 0;
        turnHandled = false;
        return;
      }
      turnConfidence = Math.min(turnConfidence + 1, TURN_CONFIDENCE_TICKS);
      if (turnConfidence < TURN_CONFIDENCE_TICKS) return;

      /* A new pick number under the same banner is a new turn. */
      const here = parseDraftPosition ? parseDraftPosition(document.body.innerText) : null;
      if (here && handledPick !== null && here.pick !== handledPick) {
        turnHandled = false;
      }
      if (turnActive && turnHandled) return; // already acted this turn, waiting for it to end
      turnActive = true;

      if (turnHandled) return;
      /* Say it at the moment it costs something. Chrome slows a hidden tab's
       * timers to about once a minute and every wait inside a list sweep with
       * them, so a turn that needs scrolling will not finish inside the pick
       * clock and Yahoo autodrafts instead. The queue is what covers that,
       * which is the other reason to keep it full. */
      if (document.hidden && !warnedHiddenTurn) {
        warnedHiddenTurn = true;
        addLog("Your turn, but this tab is in the background — Chrome slows the panel to a crawl there. Yahoo will autodraft from the queue if the panel can't finish in time.");
      }
      if (here) handledPick = here.pick;
      /* Claim the turn before anything slow runs. Resolving can take several
       * seconds — it may search the room more than once — while polls come
       * every four, so two ticks were both clearing this check and acting on
       * the same turn. Seen live: Patrick Mahomes auto-filled twice. */
      turnHandled = true;

      /* Resolve to someone the room can actually produce, skipping past
       * anyone already drafted. */
      /* A bigger budget at the turn than anywhere else.
       *
       * Four candidates is plenty against a board that matches the room, and
       * nowhere near enough against one that has fallen behind: every name
       * the room has already drafted costs a skip, and running out of skips
       * means the pick goes to Yahoo. Names the ledger is resting are refused
       * instantly and cost nothing, so the budget is mostly spent on
       * first encounters. */
      const resolved = await resolveAvailableRecommendation(10);
      const searchBox = resolved.searchBox;
      const clearSearch = () => closeSearch(searchBox);
      const playerEl = resolved.el;
      if (resolved.name) currentRecName = resolved.name;
      if (resolved.snapshot) render(resolved.snapshot);

      if (!playerEl) {
        const listHidden = document.querySelectorAll('[data-icon*="star" i]').length < 5 &&
          !document.querySelector("button[class]:not([disabled])");
        addLog(listHidden
          ? `Your turn — the Players list isn't open, so ${currentRecName || "the pick"} can't be drafted from here.`
          : `Your turn — couldn't find "${currentRecName || "a recommendation"}" in this room, draft it manually.`);
        await clearSearch();
        return;
      }

      highlightElement(playerEl);

      /* This room has no confirm step: its Draft button submits the pick the
       * moment it is clicked. So the two-level split is not "select, then
       * confirm" here — it is "show you the pick" versus "make it". */
      const recRowMeta = (boardPlayers || []).find((p) => p.name === currentRecName) || null;

      /* The list re-renders constantly, so an element found a moment ago may
       * already be detached — and a detached row has no Draft button to
       * press. Look again, now, rather than acting on a stale reference. */
      if (playerEl && !document.contains(playerEl)) {
        addLog(`${currentRecName}'s row was re-rendered — finding it again.`);
      }
      const draftBtn = findDraftButton(document.body, currentRecName, { player: recRowMeta });

      if (!autoFullBox.checked) {
        addLog(draftBtn
          ? `Your pick: ${currentRecName} — his Draft button is highlighted, press it.`
          : `Your pick: ${currentRecName} — found on the page, draft him.`);
        highlightElement(draftBtn || playerEl);
        await clearSearch();
        return;
      }

      if (!draftBtn) {
        const recMeta = (boardPlayers || []).find((p) => p.name === currentRecName) || null;
        if (explainMissingControl(currentRecName, recMeta, "Draft button")) {
          noteUnconfirmed(currentRecName, true);
        }
        addLog(`Found ${currentRecName} but no Draft button on his row — draft him manually.`);
        await clearSearch();
        return;
      }
      await wait(jitterDelay());
      clickElement(draftBtn);
      addLog(`Drafted ${currentRecName}.`);
      recordPickDecision(currentRecName);
      await clearSearch();
    } catch (err) {
      // A throw mid-search would otherwise leave detection suspended for the
      // rest of the draft, silently.
      if (detectionSuspended) {
        detectionSuspended = false;
        previousBoardNames = null;
        previousScrollTop = null;
      }
      if (isContextGone(err)) return handleDeadContext();
      /* Not silent any more. This swallowed a ReferenceError on every turn —
       * recRowMeta was referenced after a refactor removed the line defining
       * it — and the panel simply did nothing at each pick with no indication
       * why. A failure during a turn is the least acceptable moment to say
       * nothing. */
      addLog(`Auto-draft failed this turn: ${String(err.message || err)}`);
    }
  }

  /* Chrome throttles a hidden tab's timers to roughly once a minute, which is
   * longer than a pick clock. One draft logged three such gaps — 16s, 52s,
   * 28s — and every turn that fell inside one went to Yahoo's autodraft.
   *
   * Mutation callbacks are not throttled that way, and the room rewrites the
   * turn banner's countdown every second, so the page itself can drive the
   * check. The gate is a timestamp rather than a debounce timer, because a
   * setTimeout here would be throttled by the very mechanism this works
   * around. Sweeps still crawl in a hidden tab — every scroll step waits —
   * but a player already rendered can be drafted without one. */
  const OBSERVER_MIN_GAP_MS = 750;
  let observerPollAt = 0;
  let observerPollRunning = false;
  function observerTick() {
    const now = Date.now();
    if (now - observerPollAt < OBSERVER_MIN_GAP_MS) return;
    observerPollAt = now;
    /* Cheap, and the reason this runs off mutations rather than a timer: the
     * room announces a pick by changing the DOM, so the announcement is seen
     * as it happens even when timers are throttled to once a minute. */
    importAnnouncedPick(document.body.innerText).catch(() => {});
    if (observerPollRunning) return;
    observerPollRunning = true;
    Promise.resolve()
      .then(pollForTurn)
      .catch(() => {}) // pollForTurn logs its own failures
      .finally(() => { observerPollRunning = false; });
  }
  /* Coming back to the tab is the one moment the panel can catch up cheaply:
   * the list renders again, and whatever was missed while it was hidden is
   * still on the page. */
  /* Coming back to the tab is a cheap moment to catch up: the list renders
   * again and whatever was missed is still on the page. Going away is no
   * longer treated as a fault in itself — a covered window reports the same
   * thing as an abandoned one, and only the sweep can tell them apart. */
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    lastBoardUpdateAt = 0; // let the next cycle sweep immediately
    observerTick();
  });

  /* The service worker's clock, for a room that has gone quiet. The observer
   * above only fires when the page changes, and a room waiting on somebody
   * else's pick can sit still for a minute at a time. */
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type !== "HEARTBEAT" || !polling) return;
    observerTick();
  });

  const turnObserver = new MutationObserver(observerTick);
  turnObserver.observe(document.body, {
    subtree: true,
    childList: true,
    characterData: true,
  });

  /* A reload starts the content script from nothing, and the team count is
   * derived from watching a round tick over — so without this the panel falls
   * back to the configured count and stays wrong until the next round begins,
   * which in a slow draft is most of a round. Restoring is safe because these
   * are stored against this room's own id. */
  if (roomId) {
    try {
      const [facts, saved] = await Promise.all([
        Storage.getRoomFacts(roomId),
        Storage.getRoomLog(roomId),
      ]);
      if (saved?.length) {
        logLines = saved;
        for (const line of saved.slice(-20)) {
          const el = document.createElement("div");
          el.textContent = line;
          log.prepend(el);
        }
      }
      if (facts?.teams) {
        detectedTeams = facts.teams;
        addLog(`Picking up where this room left off: ${facts.teams} teams.`);
      }
      if (facts?.format?.starters) detectedFormat = facts.format;
    } catch {
      // Nothing stored, or storage is gone; the detectors will work it out
      // again from the next round change.
    }
  }

  refresh();
  timers = [
    setInterval(refresh, POLL_INTERVAL_MS * 2),
    setInterval(pollPage, POLL_INTERVAL_MS),
    setInterval(pollForTurn, POLL_INTERVAL_MS),
  ];
  observers = [turnObserver];
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", main);
} else {
  main();
}
