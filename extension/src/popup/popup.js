import { Storage } from "../lib/storage.js";
import { parseRosterText } from "../lib/textMatch.js";
import { buildOffersForTeam } from "../engine/tradeTargeter.js";

// Extension pages (popup, options) run in a privileged context — importing
// engine/lib modules directly here is always allowed, unlike a content
// script injected into a foreign page.
chrome.action.setBadgeText({ text: "" }); // clear any "new picks" indicator on open

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!response.ok) return reject(new Error(response.error));
      resolve(response.result);
    });
  });
}

let STATE = null;

function showErr(msg) {
  const el = document.getElementById("err");
  el.hidden = !msg;
  el.textContent = msg || "";
}

// --- tabs ----------------------------------------------------------------

for (const btn of document.querySelectorAll(".tab")) {
  btn.addEventListener("click", () => {
    for (const b of document.querySelectorAll(".tab")) b.classList.remove("active");
    for (const p of document.querySelectorAll(".tab-panel")) p.hidden = true;
    btn.classList.add("active");
    document.getElementById(`tab-${btn.dataset.tab}`).hidden = false;
    if (btn.dataset.tab === "trades") loadTradesTab();
  });
}

// --- draft tab -------------------------------------------------------------

document.getElementById("version").textContent = `v${chrome.runtime.getManifest().version}`;

function renderDraft() {
  document.getElementById("practiceBanner").hidden = !STATE.practice;
  const rec = STATE.recommendation;
  document.getElementById("recName").textContent = rec ? `${rec.name} — ${rec.pos}, ${rec.team} (Tier ${rec.tier})` : "Board is empty";
  document.getElementById("recWhy").textContent = rec ? rec.reason : "";
  const flag = document.getElementById("recFlag");
  flag.hidden = !(rec && rec.needOverride);
  flag.textContent = "Forced pick — a starter slot is about to go unfilled";
  document.getElementById("take").disabled = !rec;

  document.getElementById("count").textContent = `${STATE.draftedCount} of ${STATE.total} drafted`;
  document.getElementById("myCount").textContent = STATE.mine.length;

  const mine = document.getElementById("mine");
  mine.innerHTML = STATE.mine.length
    ? STATE.mine.map((p) => `<li>${p.pos} <b>${p.name}</b> <span class="muted">${p.team}</span></li>`).join("")
    : `<li class="muted">No picks yet.</li>`;

  document.getElementById("scarcity").innerHTML = STATE.scarcity.map((l) => `<li>${l}</li>`).join("");

  renderRows();
}

function renderRows() {
  const q = document.getElementById("q").value.trim().toLowerCase();
  const pos = document.getElementById("pos").value;
  const hide = true; // popup stays compact — always hide drafted players

  const rows = STATE.board
    .filter((p) => (!q || p.name.toLowerCase().includes(q)) && (!pos || p.pos === pos) && (!hide || !p.draftedBy))
    .slice(0, 60);

  document.getElementById("rows").innerHTML =
    rows
      .map((p) => {
        const cls = p.draftedBy ? `gone ${p.draftedBy}` : "";
        const acts = p.draftedBy
          ? ""
          : `<button data-mine="${encodeURIComponent(p.name)}">Mine</button>
             <button data-rival="${encodeURIComponent(p.name)}">Taken</button>`;
        const note = p.note ? `<div class="note">${p.noteTag}: ${p.note}</div>` : "";
        return `<tr class="${cls}">
          <td><b>${p.name}</b> <span class="muted">${p.team}</span>${note}</td>
          <td>${p.pos}</td><td>${p.adp}</td>
          <td class="acts">${acts}</td></tr>`;
      })
      .join("") || `<tr><td colspan="4" class="muted">No players match.</td></tr>`;
}

document.getElementById("q").addEventListener("input", renderRows);
document.getElementById("pos").addEventListener("change", renderRows);

document.getElementById("rows").addEventListener("click", async (ev) => {
  const btn = ev.target.closest("button");
  if (!btn) return;
  try {
    if (btn.dataset.mine) STATE = await sendMessage({ type: "MARK_PICK", name: decodeURIComponent(btn.dataset.mine), by: "mine" });
    else if (btn.dataset.rival) STATE = await sendMessage({ type: "MARK_PICK", name: decodeURIComponent(btn.dataset.rival), by: "rival" });
    showErr(null);
    renderDraft();
  } catch (err) {
    showErr(String(err.message || err));
  }
});

document.getElementById("take").addEventListener("click", async () => {
  try {
    STATE = await sendMessage({ type: "AUTOPICK", commit: true });
    showErr(null);
    renderDraft();
  } catch (err) {
    showErr(String(err.message || err));
  }
});

document.getElementById("reset").addEventListener("click", async () => {
  if (!confirm("Clear every pick and start over?")) return;
  STATE = await sendMessage({ type: "RESET_DRAFT" });
  renderDraft();
});

// --- trades tab -------------------------------------------------------------

async function loadTradesTab() {
  const myRoster = await Storage.getMyRoster();
  document.getElementById("myRosterText").value = myRoster.map((p) => `${p.name} ${p.team} - ${p.pos}`).join("\n");

  const leagueRosters = await Storage.getLeagueRosters();
  const select = document.getElementById("targetTeam");
  select.innerHTML = Object.keys(leagueRosters).length
    ? Object.keys(leagueRosters).map((name) => `<option>${name}</option>`).join("")
    : `<option disabled selected>No rival rosters yet — import them in Settings</option>`;
}

document.getElementById("saveMyRoster").addEventListener("click", async () => {
  const text = document.getElementById("myRosterText").value;
  const rows = parseRosterText(text);
  await Storage.setMyRoster(rows);
  showErr(null);
  alert(`Saved ${rows.length} player(s).`);
});

document.getElementById("genOffers").addEventListener("click", async () => {
  try {
    const teamName = document.getElementById("targetTeam").value;
    if (!teamName) return;
    const [myRoster, leagueRosters, config] = await Promise.all([
      Storage.getMyRoster(), Storage.getLeagueRosters(), Storage.getConfig(),
    ]);
    const adpLookup = new Map(STATE.board.map((p) => [p.name, { adp: p.adp }]));
    const offers = buildOffersForTeam(teamName, leagueRosters[teamName] || [], myRoster, adpLookup, config, 3);

    const box = document.getElementById("offers");
    box.innerHTML = offers.length
      ? offers.map((o) => `<div class="offer">${o.trim()}</div>`).join("")
      : `<div class="muted">No obvious lowball angle yet (roster data may be incomplete).</div>`;
  } catch (err) {
    showErr(String(err.message || err));
  }
});

// --- boot -------------------------------------------------------------

(async function init() {
  try {
    STATE = await sendMessage({ type: "GET_SNAPSHOT" });
    renderDraft();
  } catch (err) {
    showErr(String(err.message || err));
  }
})();
