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
      <button id="fm-pool">Import player pool from Yahoo</button>
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
    findQueueNames, withoutQueuePanel, Storage, isMyTurn, looksLikeAFutureTurn, findPlayerClickTarget, findConfirmClickTarget,
    highlightElement, clickElement, DEFAULT_CONFIRM_PHRASES, findPlayerSearchBox,
    setInputValue, surnameOf, findListScroller, findQueueStar, findDraftButton;
  ({ findBoardNames, diffDrafted, findMyTeamNames, findRosterSlots, findRosterTotal,
     findAmbiguousAbbrevs, findQueueNames, withoutQueuePanel } =
    await import(chrome.runtime.getURL("src/lib/textMatch.js")));
  ({ Storage } = await import(chrome.runtime.getURL("src/lib/storage.js")));
  ({ fetchPool, leagueIdFromUrl } = await import(chrome.runtime.getURL("src/lib/yahooPool.js")));
  ({ isMyTurn, looksLikeAFutureTurn } = await import(chrome.runtime.getURL("src/lib/turnDetect.js")));
  ({ findPlayerClickTarget, findConfirmClickTarget, highlightElement, clickElement,
     DEFAULT_CONFIRM_PHRASES, findPlayerSearchBox, setInputValue, surnameOf,
     findListScroller, findQueueStar, findDraftButton } =
    await import(chrome.runtime.getURL("src/lib/domActions.js")));

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
  let lastPollAt = Date.now();
  let previousBoardNames = null;
  let boardNameSet = null;
  let boardPlayers = null;
  let lastConfig = null;
  /* Set while the room's search box is filtered: the filter removes most of
   * the board from the page text, and the pick detector would read that as
   * every one of those players being drafted at once. */
  let detectionSuspended = false;
  const QUEUE_DEPTH = 5;
  let queueEnabled = false;
  let lastQueueRunAt = 0;
  /* Queue maintenance and a board update both drive the room's search box.
   * Whichever starts second must wait, or it reads a list the other one is
   * filtering — which is how pressing Update mid-cycle got told to clear a
   * search the user never typed. */
  let roomBusy = false;
  /* What we put in the room's queue. Yahoo removes a player from the queue
   * when someone drafts him, so anything that leaves this set without us
   * drafting him is a pick we never saw — the cheapest, most reliable pick
   * detector available, and it costs nothing to read. */
  const queuedByUs = new Set();
  const reportedAmbiguous = new Set();
  let currentRecName = null;
  let turnPhrases = [];
  let confirmPhrases = [];
  let turnActive = false;   // was the "your turn" phrase present last poll
  let turnHandled = false;  // already acted on this turn (reset when the phrase clears)
  const TURN_CONFIDENCE_TICKS = 2;
  let turnConfidence = 0;

  head.addEventListener("click", () => {
    body.classList.toggle("collapsed");
    root.querySelector("#fm-collapse-icon").textContent = body.classList.contains("collapsed") ? "+" : "–";
  });

  root.querySelector("#fm-reload").addEventListener("click", () => location.reload());

  Storage.getPollMode().then((mode) => { modeSelect.value = mode; });
  modeSelect.addEventListener("change", () => {
    Storage.setPollMode(modeSelect.value);
    previousBoardNames = null; // avoid a false diff across a mode switch
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
  Storage.getTurnPhrases().then((phrases) => { turnPhrases = phrases; });
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
    recName.textContent = rec ? `${rec.name} — ${rec.pos}, ${rec.team}` : "Board is empty";
    recWhy.textContent = rec ? rec.reason : "";
    recFlag.hidden = !(rec && rec.needOverride);
    if (rec && rec.needOverride) recFlag.textContent = "Forced pick — a starter slot is about to go unfilled";
    takeBtn.disabled = !rec;
  }

  async function refresh() {
    try {
      const snapshot = await sendMessage({ type: "GET_SNAPSHOT" });
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

  function addLog(text) {
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
    const parts = name.trim().split(/\s+/);
    if (parts.length < 2 || !surnameOf) return false;
    const last = surnameOf(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?<!\\w)${parts[0][0]}\\.\\s?${last}(?!\\w)`, "i").test(text);
  }

  const LIST_COMPLETE_ROWS = 60;
  function missingFromFullList(name) {
    const scroller = findListScroller(document.body);
    if (!scroller || !boardNameSet) return false;
    const text = scroller.innerText || "";

    /* Count players from OUR board, not name-shaped text. A scrolling list of
     * something else — managers, pick history, anything — clears a raw
     * pattern count easily, and then every candidate looks absent. That
     * marked Jahmyr Gibbs drafted in a room where the draft had not started
     * and no player had been taken at all. */
    const present = findBoardNames(text, boardNameSet, boardPlayers);
    if (present.size < LIST_COMPLETE_ROWS) return false;
    if (present.has(name)) return false;
    // Ambiguous is not absent.
    return !nameAppears(name, text);
  }

  async function locatePlayer(name, meta) {
    let el = findPlayerClickTarget(document.body, name, { player: meta });
    if (el) return { el, searchBox: null, searched: false, filtered: false };

    if (missingFromFullList(name)) {
      // The whole list is on screen and he isn't in it.
      return { el: null, searchBox: null, searched: false, filtered: true };
    }

    const searchBox = findPlayerSearchBox(document.body);
    if (!searchBox) return { el: null, searchBox: null, searched: false, filtered: false };

    /* Not finding someone is only evidence they're drafted if the search
     * actually ran. Straight after a board sweep the list is still
     * re-rendering, and a search that hasn't taken effect looks exactly like
     * a player who isn't there — which marked Davante Adams and D'Andre Swift
     * drafted seconds after the same sweep counted both as available. So
     * check the list actually narrowed before drawing any conclusion. */
    const before = countNames();
    detectionSuspended = true;
    setInputValue(searchBox, surnameOf(name));
    let filtered = false;
    for (let waited = 0; waited < 5000; waited += 250) {
      await wait(250);
      el = findPlayerClickTarget(document.body, name, { player: meta });
      if (el) return { el, searchBox, searched: true, filtered: true };
      if (!filtered && countNames() < before) filtered = true;
    }
    /* The search narrowed the list but we still couldn't identify him: that
     * means the row is there and something about it didn't confirm, not that
     * he's drafted. Only a page without his name at all is evidence. */
    const gone = filtered && !nameAppears(name, document.body.innerText);
    return { el: null, searchBox, searched: true, filtered: gone };
  }

  async function closeSearch(searchBox) {
    if (!searchBox) return;
    setInputValue(searchBox, "");
    await wait(400);
    previousBoardNames = null; // the filtered page was never a real board
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
    let skipped = 0;
    let searchBox = null;
    for (let skips = 0; skips <= maxSkips; skips++) {
      const snapshot = await sendMessage({ type: "GET_SNAPSHOT" });
      const name = snapshot.recommendation?.name;
      if (!name) return { snapshot, name: null, el: null, searchBox, skipped, exhausted: false };

      const meta = (boardPlayers || []).find((p) => p.name === name) || null;
      await closeSearch(searchBox);
      const located = await locatePlayer(name, meta);
      searchBox = located.searchBox;
      if (located.el) return { snapshot, name, el: located.el, searchBox, skipped, exhausted: false };

      if (!located.filtered) {
        // Either there's no search box, or the search never took effect. In
        // both cases absence proves nothing, so change nothing.
        return { snapshot, name, el: null, searchBox, skipped, exhausted: false };
      }
      addLog(`${name} isn't in this room any more — marking drafted and taking the next name.`);
      await sendMessage({ type: "IMPORT_PICKS", names: [name], by: "rival" });
      skipped++;
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

    /* Refresh the board first if it's been a few minutes: a shortlist built
     * from a stale board is a list of players who are already gone, and the
     * cycle below would spend itself discovering that one name at a time. */
    if (Date.now() - lastBoardUpdateAt > 180000) {
      noteQueueIdle("queue: refreshing the board first");
      roomBusy = true;
      try {
        const out = await updateBoardFromRoom({ verify: false });
        if (out.ok) {
          addLog(`Board refreshed: ${out.result.seen} available, ${out.result.markedDrafted} newly drafted, ${out.result.freed} put back.`);
        } else {
          noteQueueIdle(`queue: couldn't refresh the board — ${out.reason}`);
        }
      } finally {
        roomBusy = false;
      }
      return; // let the next cycle queue against the fresh board
    }

    if (!boardNameSet) return noteQueueIdle("queue: waiting — the board hasn't loaded yet");
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
        const wanted = await sendMessage({ type: "GET_SHORTLIST", n: QUEUE_DEPTH });
        const pick = wanted.find(
          (p) => !inRoom.has(p.name) && !queuedByUs.has(p.name) && !tried.has(p.name)
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
        searchBox = located.searchBox;
        if (!located.el) {
          if (!searchBox && !located.filtered) {
            noteQueueIdle("queue: no search box on this page, so players can't be found to queue");
            break;
          }
          if (!located.filtered) {
            // Couldn't confirm him either way: don't touch the board, and try
            // the next name rather than ending the cycle.
            tried.add(pick.name);
            noteQueueIdle(`queue: couldn't confirm ${pick.name} in the room — trying the next name`);
            continue;
          }
          // The room can't produce him: he's drafted. Same reasoning the
          // recommendation resolver uses. Doesn't count against the budget.
          await sendMessage({ type: "IMPORT_PICKS", names: [pick.name], by: "rival" });
          addLog(`${pick.name} isn't in the room — marking drafted.`);
          continue;
        }
        const star = findQueueStar(document.body, pick.name, { player: meta });
        if (!star) {
          tried.add(pick.name);
          noteQueueIdle(`queue: found ${pick.name} but no star on his row — trying the next name`);
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
  const MIN_ROWS_TO_TRUST = 60;
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
    if (!boardNameSet) {
      const snap = await sendMessage({ type: "GET_SNAPSHOT" });
      boardNameSet = new Set(snap.board.map((p) => p.name));
      boardPlayers = snap.board;
    }

    const seen = new Set();
    detectionSuspended = true;
    try {
      await sweepList(() => {
        for (const name of findBoardNames(scroller.innerText, boardNameSet, boardPlayers)) {
          seen.add(name);
        }
      });
    } finally {
      detectionSuspended = false;
      previousBoardNames = null;
    }

    if (seen.size < MIN_ROWS_TO_TRUST) {
      return { ok: false, reason: `only ${seen.size} players read — too few to trust` };
    }
    const result = await sendMessage({ type: "REPAIR_BOARD", names: [...seen] });
    lastBoardUpdateAt = Date.now();

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
      const leagueId = leagueIdFromUrl(location.href);
      if (!leagueId) {
        addLog("No league id in this page's address — open your league's Players page.");
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
  async function sweepList(collect) {
    const scroller = findListScroller(document.body);
    collect(document.body.innerText);
    if (!scroller) return { scrolled: false, steps: 0 };

    const startTop = scroller.scrollTop;
    const step = Math.max(200, scroller.clientHeight - 60);
    let steps = 0;
    for (let top = 0; top <= scroller.scrollHeight && steps < 40; top += step, steps++) {
      scroller.scrollTop = top;
      await wait(160); // let the list render the rows it just revealed
      collect(document.body.innerText);
      if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2) break;
    }
    scroller.scrollTop = startTop;
    await wait(120);
    return { scrolled: true, steps };
  }

  async function pollPage() {
    if (!polling || detectionSuspended) return;

    /* Chrome throttles timers in a hidden tab to about once a minute, and
     * discards tabs outright under Memory Saver. Either way the poll simply
     * stops for a while, and picks made in that window are never seen — the
     * panel comes back looking healthy and quietly out of date. It can't
     * prevent that, but it can refuse to hide it. */
    const now = Date.now();
    const gap = now - lastPollAt;
    lastPollAt = now;
    if (gap > POLL_INTERVAL_MS * 3) {
      addLog(`Stopped watching for ${Math.round(gap / 1000)}s (tab was in the background?) — picks may have been missed. Re-sync.`);
      updateBtn.classList.add("stale");
    }

    try {
      if (!boardNameSet) {
        const snapshot = await sendMessage({ type: "GET_SNAPSHOT" });
        boardNameSet = new Set(snapshot.board.map((p) => p.name));
        boardPlayers = snapshot.board;
      }
      const text = document.body.innerText;
      await importMyTeam(text);
      checkRosterShape(text, lastConfig);
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

      if (previousBoardNames) {
        // "appear": a picks feed — names show up as taken.
        // "disappear": an available-player pool — names leave it as taken.
        const newlyDrafted = inferDraftedFromPoll(previousBoardNames, found, modeSelect.value);
        if (newlyDrafted.size > 0) {
          const names = [...newlyDrafted];
          const { changed } = await sendMessage({ type: "DETECTED_PICKS", names });
          if (changed) {
            for (const name of names) addLog(`Detected: ${name}`);
            await refresh();
          }
        }
      }
      previousBoardNames = found;
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
      if (turnActive && turnHandled) return; // already acted this turn, waiting for it to end
      turnActive = true;

      if (turnHandled) return;
      /* Claim the turn before anything slow runs. Resolving can take several
       * seconds — it may search the room more than once — while polls come
       * every four, so two ticks were both clearing this check and acting on
       * the same turn. Seen live: Patrick Mahomes auto-filled twice. */
      turnHandled = true;

      /* Resolve to someone the room can actually produce, skipping past
       * anyone already drafted. */
      const resolved = await resolveAvailableRecommendation();
      const searchBox = resolved.searchBox;
      const clearSearch = () => closeSearch(searchBox);
      const playerEl = resolved.el;
      if (resolved.name) currentRecName = resolved.name;
      if (resolved.snapshot) render(resolved.snapshot);

      if (!playerEl) {
        addLog(`Your turn — couldn't find "${currentRecName || "a recommendation"}" in this room, draft it manually.`);
        await clearSearch();
        return;
      }

      highlightElement(playerEl);

      /* This room has no confirm step: its Draft button submits the pick the
       * moment it is clicked. So the two-level split is not "select, then
       * confirm" here — it is "show you the pick" versus "make it". */
      const recRowMeta = (boardPlayers || []).find((p) => p.name === currentRecName) || null;
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
        addLog(`Found ${currentRecName} but no Draft button on his row — draft him manually.`);
        await clearSearch();
        return;
      }
      await wait(jitterDelay());
      clickElement(draftBtn);
      addLog(`Drafted ${currentRecName}.`);
      await clearSearch();
    } catch (err) {
      // A throw mid-search would otherwise leave detection suspended for the
      // rest of the draft, silently.
      if (detectionSuspended) {
        detectionSuspended = false;
        previousBoardNames = null;
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

  refresh();
  timers = [
    setInterval(refresh, POLL_INTERVAL_MS * 2),
    setInterval(pollPage, POLL_INTERVAL_MS),
    setInterval(pollForTurn, POLL_INTERVAL_MS),
  ];
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", main);
} else {
  main();
}
