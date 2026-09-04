/*
 * Real-browser verification of lib/domActions.js (click-target finding),
 * against a synthetic page modeled on common draft-room patterns — this
 * environment has no access to fantasysports.yahoo.com to test against the
 * real thing, so this is the strongest available check: real DOM, real
 * TreeWalker, real element.click() dispatch, via the bundled Chromium
 * (same technique as load_check.js), not a hand-simulated assertion.
 *
 * Not part of the extension itself; a one-off check for this build. Not
 * wired into CI (no Playwright/Chromium there) — run manually:
 *   NODE_PATH=$(npm root -g) node extension/test/domActions.check.js
 */
import { chromium } from "playwright";
import http from "node:http";
import { readFileSync, writeFileSync, unlinkSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = join(HERE, "..");
// Playwright's own Chromium: branded Google Chrome ignores --load-extension
// (see load_check.js), and a fixed path only exists in one build environment.
const CHROME = process.env.FM_CHROME || chromium.executablePath();

// A synthetic page mixing the three interactive patterns a draft room might
// plausibly use for a player row: a real <button>, a plain <div> with an
// onclick handler (framework rows often skip semantic buttons), and a
// non-interactive one — plus a confirm dialog and a decoy that must NOT be
// matched (our own overlay repeats the player's name and has a button whose
// label contains "draft").
const PAGE_HTML = `<!doctype html><html><body>
  <div id="fantasy-manager-overlay">
    <div>Jahmyr Gibbs — RB, Det</div>
    <button>I drafted this player</button>
  </div>

  <ul id="board">
    <li><button class="player-row">Jahmyr Gibbs Det - RB</button></li>
    <li><div class="player-row" onclick="window.__clicked='div-row'">Josh Allen Buf - QB</div></li>
    <li><span>Puka Nacua LAR - WR</span></li>

    <!-- How Yahoo actually renders a row: initial and surname only, with the
         position and team beside it. No full name appears anywhere. -->
    <li><button class="row-abbrev">J. JEFFERSON (WR · Min)</button></li>

    <!-- Same abbreviation, two players, same position: only the team tells
         them apart, and clicking the wrong one drafts the wrong player. -->
    <li><button class="row-bijan">B. Robinson RB Atl</button></li>
    <li><button class="row-brian">B. Robinson RB Was</button></li>
  </ul>

  <div id="confirmDialog" style="display:none">
    <button id="cancelBtn">Cancel</button>
    <button id="confirmBtn">Draft</button>
  </div>

  <!-- Yahoo renders only a window of the player list, so most players are
       absent from the DOM until searched for. This models that: the row does
       not exist until the search box filters to it. -->
  <input id="playerSearch" type="text" placeholder="Search for a player">
  <ul id="virtual"></ul>

  <!-- The real draft room's layout, confirmed live: each player is a table
       row whose FIRST cell holds the queue star and whose second holds the
       name. Anything scoped to the name's own cell cannot reach the star. -->
  <div id="pick-feed">Last: D. ACHANE (RB · Mia)</div>
  <div id="queue-panel">Autodraft will pick from queue
    <div class="q-entry"><button class="q-remove"><svg data-icon="star-filled"></svg></button>
      <span>J. Hurts</span> <span>QB</span> <span>Phi</span></div>
    <div class="q-entry"><button class="q-remove"><svg data-icon="star-filled"></svg></button>
      <span>M. Lloyd</span> <span>RB</span> <span>GB</span></div>
  </div>
  <table id="board-table"><tbody>
    <tr id="row-kelce">
      <td><button class="star-btn"><svg data-icon="star-unfilled"></svg></button></td>
      <td><span>T. Kelce</span> <span>TE</span> <span>KC</span> <span>Bye 5</span></td>
      <td>21.0</td>
    </tr>
    <tr id="row-draftable">
      <td><button class="draft-btn">Draft</button></td>
      <td><span>D. Achane</span> <span>RB</span> <span>Mia</span> <span>Bye 6</span></td>
      <td>15.3</td>
    </tr>
    <tr id="row-queued">
      <td><button class="star-btn"><svg data-icon="star-filled"></svg></button></td>
      <td><span>P. Nacua</span> <span>WR</span> <span>LAR</span> <span>Bye 11</span></td>
      <td>5.0</td>
    </tr>
  </tbody></table>

  <nav><a href="#">Mock Draft Lobby</a></nav>

  <script>
    const OFFSCREEN = [{ name: "B. BOWERS", meta: "TE \u00b7 LV \u00b7 Bye 13" }];
    document.getElementById('playerSearch').addEventListener('input', (e) => {
      const q = e.target.value.trim().toLowerCase();
      const ul = document.getElementById('virtual');
      ul.innerHTML = '';
      if (!q) return;
      for (const row of OFFSCREEN) {
        if (!row.name.toLowerCase().includes(q)) continue;
        const li = document.createElement('li');
        const btn = document.createElement('button');
        btn.className = 'virtual-row';
        btn.textContent = row.name + ' ' + row.meta;
        li.appendChild(btn);
        ul.appendChild(li);
      }
    });

    // DOM attributes, not window globals: window is per-JS-world (main page
    // vs. the extension's isolated content-script world), but this same
    // document is shared, so this is the one channel both sides can see.
    document.querySelectorAll('.player-row').forEach((el) => {
      el.addEventListener('click', () => {
        document.body.dataset.clicked = el.tagName.toLowerCase() === 'div' ? 'div-row' : 'button-row';
        document.getElementById('confirmDialog').style.display = 'block';
      });
    });
    document.getElementById('confirmBtn').addEventListener('click', () => {
      document.body.dataset.confirmed = 'true';
    });
  </script>
</body></html>`;

// Content scripts run in an isolated JS world with their own \`window\` —
// distinct from the page's own \`window\` even though they share the same
// \`document\`. Setting window.__probeResult here would be invisible to
// page.evaluate() on the Playwright side, so the result crosses back via a
// DOM attribute instead, which genuinely is shared.
const PROBE_CONTENT_SRC = `
(async () => {
  const mod = await import(chrome.runtime.getURL("test/_probe_module.js"));
  const result = await mod.run(document);
  document.documentElement.setAttribute("data-fm-probe-result", JSON.stringify(result));
})();
`;

const PROBE_MODULE_SRC = `
import { findPlayerClickTarget, findConfirmClickTarget, clickElement, DEFAULT_CONFIRM_PHRASES,
  findPlayerSearchBox, setInputValue, surnameOf, findQueueStar,
  findDraftButton, findQueueRemove } from "../src/lib/domActions.js";
import { parsePoolPage } from "../src/lib/yahooPool.js";

export async function run(document) {
  const results = {};

  const gibbs = findPlayerClickTarget(document.body, "Jahmyr Gibbs");
  results.gibbsTag = gibbs ? gibbs.tagName : null;

  const allen = findPlayerClickTarget(document.body, "Josh Allen");
  results.allenClass = allen ? allen.className : null;

  // Must not match our own overlay's repeated player name / "draft" button.
  const overlayMatch = findPlayerClickTarget(document, "Jahmyr Gibbs");
  results.overlayLeak = document.getElementById("fantasy-manager-overlay").contains(overlayMatch);

  clickElement(allen);
  await new Promise((r) => setTimeout(r, 50));
  results.divClickFired = document.body.dataset.clicked === "div-row";

  document.getElementById("confirmDialog").style.display = "block";
  const confirmBtn = findConfirmClickTarget(document.body, DEFAULT_CONFIRM_PHRASES);
  results.confirmFound = confirmBtn ? confirmBtn.id : null;
  clickElement(confirmBtn);
  await new Promise((r) => setTimeout(r, 50));
  results.confirmClicked = document.body.dataset.confirmed === "true";

  // "Draft" must not match the unrelated nav link "Mock Draft Lobby".
  const navEl = document.querySelector("nav a");
  results.navNotMatched = confirmBtn !== navEl;

  const missing = findPlayerClickTarget(document.body, "Nobody Real");
  results.missingIsNull = missing === null;

  // The room writes "J. JEFFERSON", never "Justin Jefferson".
  const abbrev = findPlayerClickTarget(document.body, "Justin Jefferson",
    { player: { pos: "WR", team: "Min" } });
  results.abbrevClass = abbrev ? abbrev.className : null;

  // Same abbreviation, two rows: the team must decide which is clicked.
  const bijan = findPlayerClickTarget(document.body, "Bijan Robinson",
    { player: { pos: "RB", team: "Atl" } });
  results.bijanClass = bijan ? bijan.className : null;
  const brian = findPlayerClickTarget(document.body, "Brian Robinson",
    { player: { pos: "RB", team: "Was" } });
  results.brianClass = brian ? brian.className : null;

  // Neither row is this player's team, so nothing may be clicked: a wrong
  // click here drafts a player and cannot be taken back.
  const wrongTeam = findPlayerClickTarget(document.body, "Bijan Robinson",
    { player: { pos: "RB", team: "Sea" } });
  results.wrongTeamRefused = wrongTeam === null;

  // A recommended player who isn't rendered: nothing to click until searched.
  const bowersMeta = { pos: "TE", team: "LV" };
  results.bowersAbsent =
    findPlayerClickTarget(document.body, "Brock Bowers", { player: bowersMeta }) === null;

  const searchBox = findPlayerSearchBox(document.body);
  results.searchBoxFound = !!searchBox;
  results.surname = surnameOf("Brock Bowers");
  setInputValue(searchBox, surnameOf("Brock Bowers"));
  await new Promise((r) => setTimeout(r, 100));
  const afterSearch = findPlayerClickTarget(document.body, "Brock Bowers", { player: bowersMeta });
  results.foundAfterSearch = afterSearch ? afterSearch.className : null;

  // And clearing it puts the page back, so detection can resume on a real board.
  setInputValue(searchBox, "");
  await new Promise((r) => setTimeout(r, 100));
  results.clearedAfterwards =
    findPlayerClickTarget(document.body, "Brock Bowers", { player: bowersMeta }) === null;

  // The overlay's own search box must never be mistaken for the room's.
  results.searchNotOurs = !document.getElementById("fantasy-manager-overlay").contains(searchBox);

  /* Yahoo's league player list, in the markup a live league page returns.
   * Both awkward names are here on purpose: a regex over the whole cell read
   * "Amon-Ra St. Brown" as team "Amon", and put A.J. Brown on the wrong team.
   * Built by concatenation because this whole probe is itself a template. */
  const poolRow = (name, team, pos, bye, proj, rank) =>
    '<tr><td></td><td></td><td><div class="ysf-player-name">' +
    '<a href="/nfl/players/1">' + name + '</a>' +
    '<span class="Fz-xxs">' + team + ' - ' + pos + '</span></div></td>' +
    '<td>FA</td><td>17</td><td>' + bye + '</td><td>' + proj + '</td><td>' + rank + '</td></tr>';
  const poolHead = '<thead><tr><th></th><th></th><th>Offense</th><th>Roster Status</th>' +
    '<th>GP*</th><th>Bye</th><th>Proj</th><th>Rank</th></tr></thead>';
  const poolHtml = '<table>' + poolHead + '<tbody>' +
    poolRow("Amon-Ra St. Brown", "Det", "WR", 6, 324, 7) +
    poolRow("A.J. Brown", "Phi", "WR", 9, 220.3, 23) +
    poolRow("Bijan Robinson", "Atl", "RB", 11, 370.8, 2) +
    poolRow("Brian Robinson", "SF", "RB", 14, 120.5, 88) +
    '</tbody></table>';
  const pool = parsePoolPage(poolHtml);
  results.poolCount = pool.length;
  results.poolHyphenated = pool.find((p) => p.name === "Amon-Ra St. Brown") || null;
  // A stat cell must never be mistaken for a bye week.
  const statRow = '<tr><td></td><td></td><td><div class="ysf-player-name">' +
    '<a href="/nfl/players/9">Jalen Hurts</a><span class="Fz-xxs">Phi - QB</span></div></td>' +
    '<td>FA</td><td>16</td><td>9</td><td>307.04</td><td>2055</td><td>3425</td></tr>';
  const statPool = parsePoolPage('<table>' + poolHead + '<tbody>' + statRow + '</tbody></table>');
  results.statBye = statPool[0]?.bye;
  results.poolInitials = pool.find((p) => p.name === "A.J. Brown") || null;
  results.poolRobinsons = pool.filter((p) => /Robinson/.test(p.name)).map((p) => p.name + "/" + p.team);

  // The queue star lives in a sibling cell of the row, not in the name's cell.
  const star = findQueueStar(document.body, "Travis Kelce", { player: { pos: "TE", team: "KC" } });
  results.starClass = star ? star.className : null;
  results.starInRightRow = star ? star.closest("tr").id : null;

  // A filled star is the remove control: clicking it would take the player
  // back out of the queue, so it must never be returned.
  const queuedStar = findQueueStar(document.body, "Puka Nacua", { player: { pos: "WR", team: "LAR" } });
  results.filledStarRefused = queuedStar === null;

  // The room's Draft button submits immediately — no confirm step — so it
  // must be found on that player's own row and nowhere else.
  const draftBtn = findDraftButton(document.body, "De'Von Achane", { player: { pos: "RB", team: "Mia" } });
  results.draftBtnClass = draftBtn ? draftBtn.className : null;
  results.draftBtnRow = draftBtn ? draftBtn.closest("tr").id : null;
  // A row without one must yield nothing rather than the nearest button.
  results.noDraftBtn = findDraftButton(document.body, "Travis Kelce", { player: { pos: "TE", team: "KC" } }) === null;
  // Achane's name appears in the pick feed first, with no row around it. The
  // lookup has to keep going to the row that has the button.
  results.draftPastFeed = findDraftButton(document.body, "De'Von Achane", { player: { pos: "RB", team: "Mia" } })?.className;

  // Removing from the queue: the only handle is in the queue panel, since a
  // queued player has no row in the available list any more.
  // Diagnostics for the lookup itself, so a null answer says where it failed.
  const qp = [...document.querySelectorAll("div, section, aside")].find((el) =>
    /Autodraft will pick from queue/i.test(el.textContent || "") && (el.textContent || "").length < 2000);
  results.qPanelFound = !!qp;
  results.qPanelId = qp ? (qp.id || qp.className || qp.tagName) : null;
  results.qEntryTexts = qp
    ? [...qp.querySelectorAll("li, div, tr")].map((e) => (e.textContent || "").replace(/\s+/g, " ").trim().slice(0, 30))
    : null;
  const removeHurts = findQueueRemove(document.body, "Jalen Hurts");
  results.removeClass = removeHurts ? removeHurts.className : null;
  results.removeIsRightEntry = removeHurts
    ? /Hurts/.test(removeHurts.closest(".q-entry")?.textContent || "")
    : false;
  results.removeMissing = findQueueRemove(document.body, "Travis Kelce") === null;

  return results;
}
`;

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(PAGE_HTML);
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

async function main() {
  const server = await startServer();
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;

  const manifestPath = join(EXT_ROOT, "manifest.json");
  const originalManifest = readFileSync(manifestPath, "utf8");
  const probeContentPath = join(EXT_ROOT, "test", "_probe_content.js");
  const probeModulePath = join(EXT_ROOT, "test", "_probe_module.js");

  // A modified manifest matching this test server's origin, with a tiny
  // probe content script in place of overlay.js (which builds a whole panel
  // and talks to background.js — this check only needs domActions.js
  // itself) — loaded via Chrome's real declarative content-script
  // mechanism, not an artificial addScriptTag path.
  const manifest = JSON.parse(originalManifest);
  manifest.content_scripts[0].matches = [`${origin}/*`];
  manifest.content_scripts[0].js = ["test/_probe_content.js"];
  manifest.host_permissions = [`${origin}/*`];
  manifest.web_accessible_resources[0].matches = [`${origin}/*`];
  manifest.web_accessible_resources[0].resources.push("test/_probe_content.js", "test/_probe_module.js");

  writeFileSync(probeContentPath, PROBE_CONTENT_SRC);
  writeFileSync(probeModulePath, PROBE_MODULE_SRC);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  const userDataDir = mkdtempSync(join(tmpdir(), "fm-domactions-"));
  let failed = false;

  try {
    const context = await chromium.launchPersistentContext(userDataDir, {
      executablePath: CHROME,
      headless: false,
      args: [
        `--disable-extensions-except=${EXT_ROOT}`,
        `--load-extension=${EXT_ROOT}`,
        "--no-sandbox",
        "--headless=new",
      ],
    });

    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", (err) => pageErrors.push(String(err)));
    page.on("console", (msg) => {
      if (msg.type() === "error") pageErrors.push(`console.error: ${msg.text()}`);
    });
    await page.goto(origin);
    await page.waitForFunction(
      () => document.documentElement.hasAttribute("data-fm-probe-result"),
      null,
      { timeout: 8000 }
    );
    const result = await page.evaluate(() =>
      JSON.parse(document.documentElement.getAttribute("data-fm-probe-result"))
    );

    console.log("Probe result:", JSON.stringify(result, null, 2));
    if (pageErrors.length) {
      console.error("Page errors:", pageErrors);
      failed = true;
    }

    const checks = [
      ["finds the real <button> player row", result.gibbsTag === "BUTTON"],
      ["finds the onclick <div> player row (not a nested span)", result.allenClass === "player-row"],
      ["never matches inside the extension's own overlay", result.overlayLeak === false],
      ["clicking the div row fires its real onclick handler", result.divClickFired === true],
      ["finds the Confirm/Draft button by text", result.confirmFound === "confirmBtn"],
      ["clicking it fires the real confirm handler", result.confirmClicked === true],
      ['does not match an unrelated nav link containing "Draft"', result.navNotMatched === true],
      ["returns null for a player who isn't on the page", result.missingIsNull === true],
      ["finds a row rendered only as an initial and surname", result.abbrevClass === "row-abbrev"],
      ["picks the right Robinson by team", result.bijanClass === "row-bijan"],
      ["picks the other Robinson by team", result.brianClass === "row-brian"],
      ["clicks nothing when no row matches the player's team", result.wrongTeamRefused === true],
      ["an unrendered player has no click target", result.bowersAbsent === true],
      ["finds the room's player search box", result.searchBoxFound === true],
      ["searches by surname", result.surname === "Bowers"],
      ["finds the row once the search filters to it", result.foundAfterSearch === "virtual-row"],
      ["clearing the search puts the page back", result.clearedAfterwards === true],
      ["never picks up our own overlay's inputs", result.searchNotOurs === true],
      ["finds the queue star in the row's other cell", result.starClass === "star-btn"],
      ["and it's the star on that player's row", result.starInRightRow === "row-kelce"],
      ["refuses a filled star, which would un-queue the player", result.filledStarRefused === true],
      ["parses every player row from Yahoo's list", result.poolCount === 4],
      ["keeps a hyphenated name whole, with the right team",
        result.poolHyphenated?.name === "Amon-Ra St. Brown" && result.poolHyphenated?.team === "DET"],
      ["handles initials with periods", result.poolInitials?.team === "PHI"],
      ["separates the two Robinsons by their real teams",
        JSON.stringify(result.poolRobinsons) === JSON.stringify(["Bijan Robinson/ATL", "Brian Robinson/SF"])],
      ["carries the bye week", result.poolHyphenated?.bye === 6],
      ["never reads a stat column as a bye week", result.statBye === 9],
      ["finds the room's Draft button on the right row",
        result.draftBtnClass === "draft-btn" && result.draftBtnRow === "row-draftable"],
      ["returns nothing when that row has no Draft button", result.noDraftBtn === true],
      ["looks past the pick feed to the row with the button", result.draftPastFeed === "draft-btn"],
      ["finds the remove control in the queue panel", result.removeClass === "q-remove"],
      ["and it belongs to that player's entry", result.removeIsRightEntry === true],
      ["returns nothing for a player who isn't queued", result.removeMissing === true],
    ];
    for (const [label, ok] of checks) {
      console.log(`  ${ok ? "PASS" : "FAIL"} — ${label}`);
      if (!ok) failed = true;
    }

    await context.close();
  } finally {
    writeFileSync(manifestPath, originalManifest);
    unlinkSync(probeContentPath);
    unlinkSync(probeModulePath);
    server.close();
  }

  if (failed) {
    console.error("\n=== domActions CHECK FAILED ===");
    process.exit(1);
  }
  console.log("\n=== domActions CHECK PASSED (synthetic page, real Chromium — not verified against live Yahoo) ===");
}

main().catch((err) => {
  console.error("Uncaught error during domActions check:", err);
  process.exit(1);
});
