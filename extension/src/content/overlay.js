/*
 * Injected into every fantasysports.yahoo.com page. Draws a small floating
 * panel showing the current recommendation, and polls the page's own
 * rendered text (never Yahoo's DOM structure — no CSS selectors, nothing
 * that breaks when Yahoo changes a class name) for opponent picks using the
 * exact same "search for known ADP names" strategy already proven in
 * fantasy_manager/browser_sync.py's `watch` command.
 *
 * DELIBERATE LIMIT: this reads the page. It never writes to it. There is no
 * code anywhere in this file that clicks, fills in, or submits anything in
 * Yahoo's own UI — drafting, roster changes, and trades all still require
 * you to act in Yahoo's own interface. That mirrors the same call already
 * made for trades throughout this project (Yahoo's API is read-only, and
 * scripting real actions risks looking like bot activity against Yahoo's
 * terms) — extended here to drafting and roster moves too, since a script
 * clicking through a live draft against real opponents is a materially
 * bigger step than a script reading a page for your own research.
 *
 * Your own pick is never inferred from what changed on the page — only
 * opponent picks are auto-detected (recorded as "rival"). You confirm your
 * own picks with one click on the recommended player, the same two-step
 * split browser_sync.py's `watch` mode already uses (it detects rivals
 * automatically; you commit your own pick yourself, deliberately).
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
        watching page for opponent picks —
        <span id="fm-toggle-poll">pause</span>
        · <select id="fm-mode" title="Which direction signals a pick on this page">
            <option value="appear">names appear (picks feed)</option>
            <option value="disappear">names disappear (player pool)</option>
          </select>
      </div>
      <div id="fm-err" hidden></div>
    </div>
  `;
  document.documentElement.appendChild(root);
  return root;
}

async function main() {
  let diffDrafted, Storage;
  ({ findBoardNames, diffDrafted } = await import(chrome.runtime.getURL("src/lib/textMatch.js")));
  ({ Storage } = await import(chrome.runtime.getURL("src/lib/storage.js")));

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

  let polling = true;
  let previousBoardNames = null;
  let boardNameSet = null;
  let currentRecName = null;

  head.addEventListener("click", () => {
    body.classList.toggle("collapsed");
    root.querySelector("#fm-collapse-icon").textContent = body.classList.contains("collapsed") ? "+" : "–";
  });

  Storage.getPollMode().then((mode) => { modeSelect.value = mode; });
  modeSelect.addEventListener("change", () => {
    Storage.setPollMode(modeSelect.value);
    previousBoardNames = null; // avoid a false diff across a mode switch
  });

  pollToggle.addEventListener("click", () => {
    polling = !polling;
    pollToggle.textContent = polling ? "pause" : "resume";
  });

  function showError(message) {
    errBox.hidden = !message;
    errBox.textContent = message || "";
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
        const newlyDrafted = diffDrafted(previousBoardNames, found, modeSelect.value);
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
      // Silent on poll errors (e.g. extension context invalidated after an
      // update) — the panel just stops updating rather than spamming errors
      // on a page the user isn't actively drafting on.
    }
  }

  refresh();
  setInterval(refresh, POLL_INTERVAL_MS * 2);
  setInterval(pollPage, POLL_INTERVAL_MS);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", main);
} else {
  main();
}
