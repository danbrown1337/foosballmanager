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
      #fm-head b { flex: 1; font-size: 12px; letter-spacing: .02em; }
      #fm-body { padding: 10px; display: block; }
      #fm-body.collapsed { display: none; }
      #fm-rec-name { font-size: 15px; font-weight: 700; margin-bottom: 2px; }
      #fm-rec-why { color: #9aa1ab; font-size: 12px; margin-bottom: 8px; }
      #fm-rec-flag { color: #fbbf24; font-size: 11px; font-weight: 650; margin-bottom: 6px; }
      #fm-take { width: 100%; padding: 7px; border: none; border-radius: 6px;
                 background: #1d4ed8; color: #fff; font-weight: 600; cursor: pointer;
                 font: inherit; margin-bottom: 8px; }
      #fm-take:disabled { opacity: .5; cursor: default; }
      #fm-log { font-size: 11px; color: #9aa1ab; max-height: 70px; overflow-y: auto;
                border-top: 1px solid #2a2f38; padding-top: 6px; }
      #fm-log div { padding: 1px 0; }
      #fm-status { font-size: 10px; color: #6b7280; margin-top: 6px; }
      #fm-toggle-poll { font-size: 10px; color: #9aa1ab; cursor: pointer; text-decoration: underline; }
      #fm-mode { font-size: 10px; background: #1e222a; color: #9aa1ab; border: 1px solid #2a2f38;
                 border-radius: 4px; padding: 1px 2px; }
      #fm-err { color: #fca5a5; font-size: 11px; margin-top: 6px; }
      #fm-dead { border-top: 1px solid #2a2f38; margin-top: 8px; padding-top: 8px;
                 color: #fca5a5; font-size: 11px; }
      #fm-dead b { color: #fecaca; }
      #fm-reload { width: 100%; margin-top: 6px; padding: 6px; border: none; border-radius: 6px;
                   background: #b91c1c; color: #fff; font: inherit; font-weight: 600; cursor: pointer; }
      #fm-auto { border-top: 1px solid #2a2f38; margin-top: 8px; padding-top: 8px; font-size: 11px; }
      #fm-auto label { display: flex; align-items: center; gap: 6px; color: #9aa1ab; margin-bottom: 4px; cursor: pointer; }
      #fm-auto label.sub { padding-left: 16px; }
      #fm-auto-status { color: #6b7280; font-size: 10px; margin-top: 2px; }
      #fm-auto-warn { color: #fbbf24; font-size: 10px; margin-top: 2px; }
    </style>
    <div id="fm-head">
      <b>Fantasy Manager</b>
      <span id="fm-collapse-icon">–</span>
    </div>
    <div id="fm-body">
      <div id="fm-rec-flag" hidden></div>
      <div id="fm-rec-name">Loading…</div>
      <div id="fm-rec-why"></div>
      <button id="fm-take" disabled>I drafted this player</button>
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
  let diffDrafted, Storage, isMyTurn, findPlayerClickTarget, findConfirmClickTarget,
    highlightElement, clickElement, DEFAULT_CONFIRM_PHRASES;
  ({ findBoardNames, diffDrafted } = await import(chrome.runtime.getURL("src/lib/textMatch.js")));
  ({ Storage } = await import(chrome.runtime.getURL("src/lib/storage.js")));
  ({ isMyTurn } = await import(chrome.runtime.getURL("src/lib/turnDetect.js")));
  ({ findPlayerClickTarget, findConfirmClickTarget, highlightElement, clickElement, DEFAULT_CONFIRM_PHRASES } =
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
  const statusBox = root.querySelector("#fm-status");

  let polling = true;
  let contextGone = false;
  let timers = [];
  let previousBoardNames = null;
  let boardNameSet = null;
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
    while (log.children.length > 6) log.removeChild(log.lastChild);
  }

  async function pollPage() {
    if (!polling) return;
    try {
      if (!boardNameSet) {
        const snapshot = await sendMessage({ type: "GET_SNAPSHOT" });
        boardNameSet = new Set(snapshot.board.map((p) => p.name));
      }
      const text = document.body.innerText;
      const found = findBoardNames(text, boardNameSet);

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
      const text = document.body.innerText;
      const active = isMyTurn(text, turnPhrases);

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

      const snapshot = await sendMessage({ type: "GET_SNAPSHOT" });
      const recommended = snapshot.recommendation?.name;
      if (!recommended) return; // nothing to draft yet (board empty / not loaded)
      if (recommended !== currentRecName) {
        currentRecName = recommended;
        turnHandled = false;
      }
      if (turnHandled) return;
      const recRow = snapshot.board.find((player) => player.name === currentRecName);
      if (!recRow || recRow.draftedBy) {
        turnHandled = true;
        return;
      }

      const playerEl = findPlayerClickTarget(document.body, currentRecName);
      if (!playerEl) {
        addLog(`Your turn detected but couldn't find "${currentRecName}" on the page — draft it manually.`);
        turnHandled = true;
        return;
      }

      turnHandled = true; // set before awaiting, so a second poll tick can't double-act
      highlightElement(playerEl);
      addLog(`Your turn — found ${currentRecName} on the page.`);

      if (!autoFullBox.checked) {
        // Default, safer mode: select the player and stop. Selecting is
        // easy to undo; the actual submit click is not, so that stays yours.
        await wait(jitterDelay());
        clickElement(playerEl);
        addLog(`Auto-filled ${currentRecName} — click Yahoo's own Confirm/Draft button to finish the pick.`);
        return;
      }

      await wait(jitterDelay());
      clickElement(playerEl);
      await wait(jitterDelay());
      const confirmEl = findConfirmClickTarget(document.body, confirmPhrases || DEFAULT_CONFIRM_PHRASES);
      if (confirmEl) {
        clickElement(confirmEl);
        addLog(`Auto-drafted ${currentRecName}.`);
      } else {
        addLog(`Selected ${currentRecName} but couldn't find a Confirm/Draft button — finish the pick manually.`);
      }
    } catch (err) {
      if (isContextGone(err)) return handleDeadContext();
      // Same policy as pollPage(): stay silent on other poll errors rather
      // than spamming the panel on a page you aren't actively drafting on.
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
