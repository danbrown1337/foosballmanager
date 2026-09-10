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

/* Player names and warnings in the Week tab come off a scraped Yahoo page, so
 * they are foreign text going into innerHTML. Nothing in a roster ought to
 * contain markup, but "ought to" is not a reason to interpolate a page's own
 * strings unescaped into an extension popup. */
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[ch]));
}

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


/* Grading, in the panel rather than in a conversation.
 *
 * Yahoo does not store mock drafts, so the only record of one is the decision
 * log this extension keeps. Grading it here is what turns a mock into a
 * measurement — the same numbers every time, against the same board the
 * engine drafted from. */
document.getElementById("gradeBtn").addEventListener("click", async () => {
  const out = document.getElementById("gradeOut");
  out.textContent = "Grading…";
  try {
    const report = await sendMessage({ type: "GRADE_DRAFT" });
    const order = ["QB", "RB", "WR", "TE", "K", "DEF"];
    const lines = order
      .filter((pos) => report.grades[pos])
      .map((pos) => `${pos} ${report.grades[pos]}`)
      .join("  ·  ");
    out.innerHTML = "";

    const overall = document.createElement("div");
    overall.textContent = report.inProgress
      ? `Draft in progress — ${report.picksMade} of ${report.spots} picks made. No overall grade yet.`
      : `Overall ${report.grades.overall} (${report.scores.overall})`;
    overall.style.fontWeight = "600";
    out.appendChild(overall);

    const byPos = document.createElement("div");
    byPos.textContent = lines;
    out.appendChild(byPos);

    if (report.constructionFlags.length) {
      const flags = document.createElement("div");
      flags.textContent = `Flags: ${report.constructionFlags.join(", ")}`;
      out.appendChild(flags);
    }
    if (report.strengths.length) {
      const good = document.createElement("div");
      good.textContent = `Strengths: ${report.strengths.join(", ")}`;
      out.appendChild(good);
    }
    /* The turns lost matter more than the picks won when the panel is only
     * taking a quarter of them. */
    if (report.turnsSeen) {
      const turns = document.createElement("div");
      const reasons = Object.entries(report.missedReasons || {})
        .map(([why, n]) => `${n} x ${why}`).join(", ");
      turns.textContent = `Turns: ${report.turnsWon} of ${report.turnsSeen} drafted by the panel` +
        (reasons ? ` — missed: ${reasons}` : "");
      out.appendChild(turns);
    }

    if (!report.log?.length) {
      const note = document.createElement("div");
      note.textContent = "No decision log for this draft — flags about when a pick was made need one.";
      out.appendChild(note);
    }
  } catch (err) {
    out.textContent = `Couldn't grade: ${err.message}`;
  }
});

document.getElementById("copyLog").addEventListener("click", async () => {
  const out = document.getElementById("gradeOut");
  try {
    const report = await sendMessage({ type: "GRADE_DRAFT" });
    await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
    out.textContent = `Copied ${report.log.length} decision(s) to the clipboard.`;
  } catch (err) {
    out.textContent = `Couldn't copy: ${err.message}`;
  }
});


/* The panel's own log, out of storage rather than off the screen.
 *
 * It is kept per room and survives a reload, a closed tab and a closed
 * window — which is the whole point, since the questions worth asking about a
 * draft ("why did that go to autodraft?") are asked after it has ended and
 * usually after the room is gone. Until now the only copy was in the panel's
 * DOM, so closing the tab destroyed the evidence. */
document.getElementById("copyPanelLog").addEventListener("click", async () => {
  const out = document.getElementById("gradeOut");
  try {
    const rooms = await sendMessage({ type: "GET_ROOM_LOGS" });
    if (!rooms.length) {
      out.textContent = "No panel logs stored yet.";
      return;
    }
    const text = rooms
      .map((room) => `=== room ${room.roomId} (${room.lines.length} lines) ===\n${room.lines.join("\n")}`)
      .join("\n\n");
    await navigator.clipboard.writeText(text);
    const newest = rooms[0];
    out.textContent =
      `Copied ${rooms.length} room log(s), ${newest.lines.length} lines from the most recent.`;
  } catch (err) {
    out.textContent = `Couldn't copy the panel log: ${err.message}`;
  }
});


/* --- Week tab -------------------------------------------------------------
 *
 * Reads the open My Team page and renders the start/sit call. The CHANGES
 * block leads, not the lineup: "start these nine" makes the reader re-derive
 * what to click, while "bench X for Y" is the move. Same reasoning as the CLI
 * report in roster_manager.py.
 */
function renderWeek(report) {
  const out = document.getElementById("weekOut");
  const label = document.getElementById("weekLabel");

  if (report.error) {
    label.textContent = "Weekly lineup";
    out.innerHTML = `<div class="muted">${escapeHtml(report.error)}</div>`;
    return;
  }

  label.textContent = report.label || "Weekly lineup";
  const parts = [];

  if (!report.hasProjections) {
    parts.push('<div class="muted">No projections found on that page, so this is '
      + "position eligibility and byes only — not a ranking.</div>");
  }

  if (report.changes.length) {
    parts.push('<div class="label">Changes to make in Yahoo</div><ul class="plain">');
    for (const c of report.changes) {
      let text;
      if (c.moveOnly) text = `Move <b>${escapeHtml(c.start)}</b> to ${escapeHtml(c.slot)}`;
      else if (!c.start) text = `Bench <b>${escapeHtml(c.bench)}</b>`;
      else if (!c.bench) text = `Start <b>${escapeHtml(c.start)}</b> into ${escapeHtml(c.slot)}`;
      else text = `${escapeHtml(c.slot)}: start <b>${escapeHtml(c.start)}</b>, bench <b>${escapeHtml(c.bench)}</b>`;
      parts.push(`<li>${text}<br><span class="muted">${escapeHtml(c.reason)}</span></li>`);
    }
    parts.push("</ul>");
  } else {
    parts.push('<div class="muted">No changes needed — Yahoo already has your '
      + "best lineup set.</div>");
  }

  parts.push('<div class="label" style="margin-top:10px">Lineup</div><ul class="plain">');
  for (const slot of report.starters) {
    if (!slot.name) {
      parts.push(`<li><b>${escapeHtml(slot.slot)}</b> — <span class="muted">empty: `
        + `${escapeHtml(slot.emptyReason || "")}</span></li>`);
      continue;
    }
    const flags = [slot.opponent, slot.status].filter(Boolean).map(escapeHtml).join(" · ");
    const proj = slot.proj === null || slot.proj === undefined ? "—" : slot.proj.toFixed(2);
    parts.push(`<li><b>${escapeHtml(slot.slot)}</b> ${escapeHtml(slot.name)} `
      + `<span class="muted">${flags}</span> — ${proj}</li>`);
  }
  parts.push("</ul>");
  if (report.hasProjections) {
    // Two numbers, not one. What Yahoo has set is the check on the parser —
    // it should match the projected total Yahoo shows on the same page — and
    // the gap to the optimum is what the changes above are worth.
    const gain = report.projected - report.currentProjected;
    parts.push(`<div class="muted">Projected total: ${report.projected.toFixed(2)}`
      + ` &nbsp;·&nbsp; as Yahoo has it set: ${report.currentProjected.toFixed(2)}`
      + (gain > 0.005 ? ` (+${gain.toFixed(2)})` : "") + "</div>");
    parts.push('<div class="muted" style="font-size:11px">The second number '
      + "should match the projected total on your Yahoo page. If it doesn't, "
      + "the projection column is being read wrong.</div>");
    if (report.currentUnprojected?.length) {
      parts.push('<div class="muted" style="font-size:11px">Not counted in it: '
        + `${report.currentUnprojected.map(escapeHtml).join(", ")} `
        + "(no projection on the page).</div>");
    }
  }

  for (const warning of report.warnings) {
    parts.push(`<div class="muted" style="margin-top:6px">! ${escapeHtml(warning)}</div>`);
  }
  parts.push(byesSection(report));
  parts.push(otherTabsWarning(report));

  out.innerHTML = parts.join("");
}

/* Byes far enough out to still be cheap to fix.
 *
 * Only the weeks where a bye would leave a starting slot SHORT — three players
 * off in week 9 is not a problem if you can still field a legal lineup, and
 * listing it would bury the week you actually have to plan for. Same rule the
 * CLI's `week` section 2 uses. */
function byesSection(report) {
  if (!report.byesChecked) {
    // "Nothing coming up" would be a claim it hasn't checked.
    return '<div class="label" style="margin-top:10px">Byes coming up</div>'
      + '<div class="muted">Set your season start in Settings to look ahead — '
      + "without it there's no way to know which week this is.</div>";
  }
  const parts = ['<div class="label" style="margin-top:10px">Byes coming up</div>'];
  if (!report.byes.length) {
    parts.push('<div class="muted">Nothing through week '
      + `${report.week + report.weeksAhead} leaves a starting slot short.</div>`);
    return parts.join("");
  }
  parts.push('<ul class="plain">');
  for (const bye of report.byes) {
    const names = bye.players
      .map((p) => `${escapeHtml(p.name)} (${escapeHtml(p.pos)})`).join(", ");
    parts.push(`<li><b>Week ${bye.week}</b> — ${names}`
      + '<br><span class="muted">you\'d be short a starter</span></li>');
  }
  parts.push("</ul>");
  return parts.join("");
}

document.getElementById("weekBtn")?.addEventListener("click", async () => {
  const out = document.getElementById("weekOut");
  out.textContent = "Reading your My Team page...";
  try {
    renderWeek(await sendMessage({ type: "WEEK_REPORT" }));
  } catch (err) {
    out.textContent = `Could not read the page: ${err.message || err}`;
  }
});


/* Two team pages open means the roster used was whichever tab Chrome listed
 * first, and a rival's roster is indistinguishable from yours on the page.
 * Silence here produces confident advice measured against someone else's
 * bench, so the panel names the page it actually read. */
function otherTabsWarning(report) {
  if (!report.otherRosterTabs) return "";
  const url = escapeHtml(report.url || report.rosterUrl || "");
  return '<div class="muted" style="margin-top:6px">! Read your roster from '
    + `${url} — ${report.otherRosterTabs} other team page`
    + `${report.otherRosterTabs > 1 ? "s were" : " was"} also open. `
    + "Close the ones that aren't yours if that isn't your team.</div>";
}

/* --- Waiver targets -------------------------------------------------------
 *
 * The same ranking the CLI's `waivers` prints, off the two open Yahoo tabs.
 * Each target leads with what it upgrades rather than what it costs: the price
 * only matters once the gain justifies the claim, and a list sorted by name
 * recognition is how you spend a third of a budget on a backup.
 */
function renderWaivers(report) {
  const out = document.getElementById("weekOut");
  const label = document.getElementById("weekLabel");

  if (report.error) {
    label.textContent = "Waiver targets";
    out.innerHTML = `<div class="muted">${escapeHtml(report.error)}</div>`;
    return;
  }

  label.textContent = `${report.label || "Week"} — waiver targets`;
  const parts = [];

  if (!report.hasProjections) {
    parts.push('<div class="muted">No weekly projections on that player list, so '
      + "these aren't ranked by what they'd add — check the Stats selector says "
      + '"Week N (proj)" and read it again.</div>');
  }

  if (!report.targets.length) {
    // Not "nothing clears your starters" — a player who would be a downgrade
    // still shows up, ranked and labelled as depth. An empty list means nobody
    // on the page can play at all.
    parts.push('<div class="muted">No pickup candidates on that page — everyone '
      + "listed is already yours, out, on IR, or on a bye.</div>");
    out.innerHTML = parts.join("");
    return;
  }

  // Ranked worst-to-least-bad still looks like a shopping list. When the best
  // thing on the wire would still be a downgrade, say so before the list rather
  // than leaving the reader to notice every gain is negative.
  if (report.hasProjections
      && report.targets.every((t) => t.gain !== null && t.gain <= 0)) {
    parts.push('<div class="muted">Nothing here upgrades a starting slot — '
      + "the closest are below, as depth only.</div>");
  }

  parts.push('<ul class="plain">');
  for (const t of report.targets) {
    const flags = [t.pos, t.team, t.status].filter(Boolean).map(escapeHtml).join(" · ");

    let price = "";
    if (report.system === "faab" && t.bidLow !== null) {
      price = `bid ${t.bidLow}–${t.bidHigh}`
        + (report.faab ? ` of ${report.faab}` : "");
    } else if (report.system === "priority") {
      price = t.worthPriority ? "worth your priority" : "not worth priority";
    }

    // Two different clocks: a free agent is gone to whoever clicks first, a
    // waiver claim waits for the run. Saying "available" for both would hand
    // someone a deadline they don't have, or hide one they do.
    let how = "";
    if (t.freeAgent) how = "free agent — add now, first come";
    else if (t.clears) how = `on waivers — claim by ${escapeHtml(t.clears)}`;
    else if (t.rosterStatus) how = "on waivers — claim required";

    parts.push(`<li><b>${escapeHtml(t.name)}</b> <span class="muted">${flags}</span>`
      + (price ? ` — ${escapeHtml(price)}` : "")
      + `<br><span class="muted">${escapeHtml(t.rationale)}`
      + (t.note ? ` — ${escapeHtml(t.note)}` : "") + "</span>"
      + (how ? `<br><span class="muted">${how}</span>` : "")
      + (t.drop
        ? `<br><span class="muted">drop candidate: ${escapeHtml(t.drop.name)} `
          + `(${escapeHtml(t.drop.pos)}, lowest-value bench spot)</span>`
        : "")
      + "</li>");
  }
  parts.push("</ul>");

  // Which system it assumed, every time. A priority league acting on a bid
  // range finds out at the worst moment otherwise; it's set in Settings.
  parts.push(`<div class="muted" style="margin-top:6px">Assuming ${escapeHtml(report.system)}`
    + (report.system === "faab" && report.faab ? `, ${report.faab} left` : "")
    + `. Pool read: ${report.poolSize} players. Claims are yours to place.</div>`);
  parts.push(otherTabsWarning(report));

  out.innerHTML = parts.join("");
}

document.getElementById("waiverBtn")?.addEventListener("click", async () => {
  const out = document.getElementById("weekOut");
  out.textContent = "Reading your team and the player list...";
  try {
    renderWaivers(await sendMessage({ type: "WAIVER_REPORT" }));
  } catch (err) {
    out.textContent = `Could not read the pages: ${err.message || err}`;
  }
});
