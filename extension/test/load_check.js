/*
 * Loads the actual unpacked extension into a real Chromium (via Playwright)
 * and checks that it runs: the background service worker registers, the popup
 * and options pages render without errors and are interactive, and the content
 * script injects its overlay on a matching Yahoo URL. This is real
 * verification that the extension loads and runs — not just that its files
 * exist.
 *
 * Not part of the extension itself, and not wired into run_all.sh: it needs a
 * browser download, while everything in run_all.sh runs on vanilla node.
 *
 *   cd extension
 *   npm install playwright
 *   npx playwright install chromium
 *   node test/load_check.js
 *
 * FM_CHROME can point at a different Chromium binary, but read the branded
 * Chrome note below before reaching for it.
 */
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT_PATH = join(HERE, "..");

// Playwright's bundled Chromium by default, so this runs anywhere the browser
// has been installed rather than only where some fixed path happens to exist.
const CHROME = process.env.FM_CHROME || chromium.executablePath();
const IS_BRANDED_CHROME = /google-chrome|chrome-stable|Google Chrome/i.test(CHROME);

// A synthetic draft room. The content script is text-driven and never reads
// Yahoo's DOM structure, so a plain page with a turn phrase and a few board
// names exercises the same paths the real room would — no account, no network.
const ADP = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "data", "adp_2026_ppr.json"), "utf8")
);
// Abbreviated exactly as the room writes them, with position and team so the
// matcher can settle any that share an initial and surname.
const SWEEP_NAMES = ADP.slice(0, 60).map((p) => {
  const [first, ...rest] = p.name.split(" ");
  return `${first[0]}. ${rest.join(" ")} ${p.pos} \u00b7 ${p.team}`;
});

/* Virtualised for real: rows are created only for the current scroll offset
 * and destroyed as they leave, exactly as the draft room does it. A single
 * read of this page can never see more than a screenful, so a sweep that
 * merely reads innerText once cannot pass. */
const FAKE_ROOM = `<html><body>
  <h1>Mock Draft Room</h1>
  <p>You're on the clock!</p>
  <div>Ja'Marr Chase</div><div>Bijan Robinson</div><div>CeeDee Lamb</div>
  <div id="scroller" style="height:120px;overflow-y:auto">
    <div id="spacer" style="height:1200px;position:relative">
      <ul id="window" style="margin:0;position:absolute;left:0;right:0"></ul>
    </div>
  </div>
  <script>
    const ROWS = ${JSON.stringify(SWEEP_NAMES)};
    const sc = document.getElementById("scroller");
    const win = document.getElementById("window");
    function renderWindow() {
      const start = Math.max(0, Math.floor(sc.scrollTop / 20));
      win.style.top = (start * 20) + "px";
      win.innerHTML = ROWS.slice(start, start + 7)
        .map((r) => '<li style="height:20px">' + r + "</li>").join("");
    }
    sc.addEventListener("scroll", renderWindow);
    renderWindow();
  </script>
</body></html>`;

async function main() {
  const userDataDir = mkdtempSync(join(tmpdir(), "fm-ext-"));
  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath: CHROME,
    headless: false, // extensions require a "real" (non-headless_shell) run
    args: [
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
      "--no-sandbox",
      "--headless=new",
    ],
  });

  let failed = false;

  // Give the service worker a moment to register.
  await new Promise((r) => setTimeout(r, 2000));

  const workers = context.serviceWorkers();
  console.log(`Browser: ${CHROME}`);
  console.log(`Service workers registered: ${workers.length}`);
  if (workers.length === 0) {
    console.error("FAIL: no service worker registered — background.js did not load.");
    if (IS_BRANDED_CHROME) {
      console.error(
        "\n  This is branded Google Chrome, which ignores --load-extension\n" +
        "  outright (a deliberate restriction since Chrome 137). Nothing was\n" +
        "  loaded at all, so this result says nothing about the extension —\n" +
        "  a minimal, valid extension fails here identically.\n" +
        "  Unset FM_CHROME to use Playwright's bundled Chromium instead."
      );
    }
    failed = true;
  } else {
    console.log(`  worker URL: ${workers[0].url()}`);
  }

  // Find the extension ID from the service worker URL (chrome-extension://<id>/...).
  let extId = null;
  if (workers.length > 0) {
    extId = new URL(workers[0].url()).host;
    console.log(`Extension ID: ${extId}`);
  } else {
    console.error("Cannot proceed to page checks without an extension ID.");
    await context.close();
    process.exit(1);
  }

  async function checkPage(name, path) {
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", (err) => pageErrors.push(String(err)));
    page.on("console", (msg) => {
      if (msg.type() === "error") pageErrors.push(`console.error: ${msg.text()}`);
    });
    await page.goto(`chrome-extension://${extId}/${path}`);
    await page.waitForTimeout(1200);
    console.log(`\n--- ${name} (chrome-extension://${extId}/${path}) ---`);
    if (pageErrors.length === 0) {
      console.log("  no errors");
    } else {
      failed = true;
      for (const e of pageErrors) console.error(`  ERROR: ${e}`);
    }
    return { page, errors: pageErrors };
  }

  const { page: popupPage } = await checkPage("popup", "src/popup/popup.html");
  const { page: optionsPage } = await checkPage("options", "src/options/options.html");

  // Exercise the popup a little: is the recommendation rendered?
  await popupPage.waitForTimeout(500);
  const recText = await popupPage.textContent("#recName").catch(() => null);
  console.log(`\nPopup recommendation text: "${recText}"`);
  if (!recText || recText.includes("Loading") || recText.trim() === "") {
    console.error("FAIL: popup never rendered a recommendation.");
    failed = true;
  }

  const rowCount = await popupPage.locator("#rows tr").count();
  console.log(`Popup board rows rendered: ${rowCount}`);
  if (rowCount === 0) {
    console.error("FAIL: popup board table is empty.");
    failed = true;
  }

  // Click a "Mine" button and confirm the recommendation changes.
  const firstMineBtn = popupPage.locator("#rows button[data-mine]").first();
  const targetName = await firstMineBtn.getAttribute("data-mine");
  await firstMineBtn.click();
  await popupPage.waitForTimeout(400);
  const newMyCount = await popupPage.textContent("#myCount");
  console.log(`After clicking Mine on ${decodeURIComponent(targetName)}: myCount = ${newMyCount}`);
  if (newMyCount !== "1") {
    console.error("FAIL: clicking Mine did not update myCount.");
    failed = true;
  }

  // Options page: does it show the confirmed roster construction as defaults?
  const flexVal = await optionsPage.inputValue("#s_FLEX");
  const kVal = await optionsPage.inputValue("#s_K");
  console.log(`\nOptions page defaults: FLEX=${flexVal} K="${kVal}"`);
  if (flexVal !== "2" || kVal !== "") {
    console.error("FAIL: options page defaults don't match the confirmed no-K, FLEX:2 league.");
    failed = true;
  }

  // Content script: does the overlay inject on a URL matching the manifest?
  // Route ONLY the Yahoo URL. A catch-all ("**/*") also intercepts the
  // overlay's own dynamic import()s of chrome-extension:// modules and serves
  // them back as text/html, which trips strict MIME checking and looks exactly
  // like a broken extension when the extension is fine.
  const roomPage = await context.newPage();
  const roomErrors = [];
  roomPage.on("pageerror", (err) => roomErrors.push(String(err)));
  roomPage.on("console", (msg) => {
    if (msg.type() === "error") roomErrors.push(`console.error: ${msg.text()}`);
  });
  await roomPage.route("https://football.fantasysports.yahoo.com/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: FAKE_ROOM })
  );
  await roomPage.goto("https://football.fantasysports.yahoo.com/f1/000000/draftclient");
  await roomPage.waitForTimeout(3000);

  const overlayText = await roomPage
    .evaluate(() => document.getElementById("fantasy-manager-overlay")?.innerText || "")
    .catch(() => "");
  // The panel must report the build it is actually running: a reloaded
  // extension leaves stale content scripts in open pages, and until this was
  // shown there was no way to tell a current panel from an old one by looking.
  const manifestVersion = JSON.parse(
    readFileSync(join(EXT_PATH, "manifest.json"), "utf8")
  ).version;
  const shownVersion = await roomPage
    .evaluate(() => document.getElementById("fm-ver")?.textContent || "")
    .catch(() => "");
  console.log(`\n--- version ---`);
  console.log(`  manifest ${manifestVersion}, panel shows "${shownVersion}"`);
  if (shownVersion !== `v${manifestVersion}`) {
    console.error("FAIL: panel does not report the running version.");
    failed = true;
  }

  console.log("\n--- content script on football.fantasysports.yahoo.com ---");
  if (!overlayText) {
    console.error("FAIL: overlay panel never injected on a matching URL.");
    failed = true;
  } else {
    console.log(`  overlay injected, first line: "${overlayText.split("\n")[0]}"`);
  }
  if (roomErrors.length > 0) {
    failed = true;
    for (const e of roomErrors) console.error(`  ERROR: ${e}`);
  }

  // Sync must walk the whole scrolling list. Reading only what is on screen
  // was catching a fraction of the picks, which left the board recommending
  // players drafted rounds earlier.
  await roomPage.click("#fm-sync");
  await roomPage.waitForTimeout(9000);
  const syncLine = await roomPage.evaluate(() =>
    [...document.querySelectorAll("#fm-log div")].map((d) => d.textContent).find((s) => /Synced/.test(s))
  );
  const syncedCount = Number((syncLine || "").match(/Synced (\d+)/)?.[1] || 0);
  console.log(`\n--- sync sweep ---`);
  console.log(`  ${syncLine}`);
  // A single read sees at most a screenful, so anything approaching the full
  // list proves the sweep scrolled and collected as it went.
  if (syncedCount < 40 || !/across \d+ screens/.test(syncLine || "")) {
    console.error(`FAIL: swept only ${syncedCount} of 60 rows — "${syncLine}"`);
    failed = true;
  }

  // Every helper the panel imports must actually be bound: these are
  // destructured from dynamic imports, so a name added to the declaration but
  // missed in the assignment stays undefined and fails only when a draft is
  // live. Clicking the verify button exercises that whole path.
  await roomPage.click("#fm-verify");
  await roomPage.waitForTimeout(4000);
  const verifyErr = await roomPage.evaluate(() => {
    const e = document.getElementById("fm-err");
    return e && !e.hidden ? e.textContent : null;
  });
  console.log(`\n--- verify button ---`);
  console.log(`  error box: ${verifyErr || "empty"}`);
  if (verifyErr) {
    console.error("FAIL: verifying the recommendation raised an error.");
    failed = true;
  }

  // Practice mode: the mock-settings swap has to reach both the form and the
  // live panel, and — the part that actually matters on draft day — restore
  // the real league settings exactly when it's switched back off.
  await optionsPage.click("#practiceToggle");
  await optionsPage.waitForTimeout(600);
  const mockFlex = await optionsPage.inputValue("#s_FLEX");
  const mockK = await optionsPage.inputValue("#s_K");
  console.log(`\n--- practice mode on ---`);
  console.log(`  options now show FLEX=${mockFlex} K=${mockK}`);
  if (mockFlex !== "1" || mockK !== "1") {
    console.error("FAIL: practice mode did not apply the Yahoo mock roster.");
    failed = true;
  }

  // The panel refreshes on its own timer; wait one full cycle for the banner.
  await roomPage.waitForTimeout(9000);
  const bannerShown = await roomPage
    .evaluate(() => {
      const el = document.getElementById("fm-practice");
      return el ? !el.hidden : false;
    })
    .catch(() => false);
  console.log(`  panel warning banner visible: ${bannerShown}`);
  if (!bannerShown) {
    console.error("FAIL: panel gave no sign it was running on mock settings.");
    failed = true;
  }

  await optionsPage.click("#practiceToggle");
  await optionsPage.waitForTimeout(600);
  const backFlex = await optionsPage.inputValue("#s_FLEX");
  const backK = await optionsPage.inputValue("#s_K");
  console.log(`--- practice mode off ---`);
  console.log(`  options restored to FLEX=${backFlex} K="${backK}"`);
  if (backFlex !== flexVal || backK !== kVal) {
    console.error(`FAIL: league settings not restored (expected FLEX=${flexVal} K="${kVal}").`);
    failed = true;
  }

  // The panel's own practice toggle must drive the same swap the options page
  // does — it is the control someone will actually reach for, sitting in a
  // room that starts a kicker their league doesn't.
  // Wait for the panel to have re-rendered after the options-page round trip,
  // so the click lands on a checkbox showing the true state.
  await roomPage.waitForFunction(
    () => document.getElementById("fm-practice-toggle")?.checked === false,
    null,
    { timeout: 15000 }
  );
  await roomPage.click("#fm-practice-toggle");
  await roomPage.waitForTimeout(1500);
  const panelPractice = await roomPage.evaluate(() => ({
    banner: document.getElementById("fm-practice")
      ? !document.getElementById("fm-practice").hidden
      : false,
    checked: document.getElementById("fm-practice-toggle")?.checked,
  }));
  await optionsPage.reload();
  await optionsPage.waitForTimeout(1000);
  const kFromPanel = await optionsPage.inputValue("#s_K");
  console.log(`\n--- practice toggled from the panel ---`);
  console.log(`  banner: ${panelPractice.banner}, box: ${panelPractice.checked}, options K=${kFromPanel}`);
  if (!panelPractice.banner || panelPractice.checked !== true || kFromPanel !== "1") {
    console.error("FAIL: the panel toggle did not apply practice mode.");
    failed = true;
  }

  await roomPage.click("#fm-practice-toggle");
  await roomPage.waitForTimeout(1500);
  await optionsPage.reload();
  await optionsPage.waitForTimeout(1000);
  const kRestored = await optionsPage.inputValue("#s_K");
  console.log(`  after toggling back: options K="${kRestored}"`);
  if (kRestored !== kVal) {
    console.error("FAIL: toggling practice off from the panel did not restore settings.");
    failed = true;
  }

  // Reset from the panel: two clicks, and the pick recorded earlier via the
  // popup must be gone. State carries between rooms otherwise, which is how a
  // fresh mock opens recommending against the previous draft.
  await roomPage.click("#fm-reset");
  await roomPage.waitForTimeout(300);
  const armedLabel = await roomPage.evaluate(
    () => document.getElementById("fm-reset")?.textContent.trim()
  );
  await roomPage.click("#fm-reset");
  await roomPage.waitForTimeout(1200);
  await popupPage.reload();
  await popupPage.waitForTimeout(1500);
  const myCountAfterReset = await popupPage.textContent("#myCount");
  console.log(`\n--- reset from the panel ---`);
  console.log(`  first click armed it ("${armedLabel}"), myCount after reset: ${myCountAfterReset}`);
  if (!/click again/i.test(armedLabel || "") || myCountAfterReset !== "0") {
    console.error("FAIL: panel reset did not clear the recorded picks.");
    failed = true;
  }

  // Regression: reloading the extension orphans the content script already
  // running in an open page — every chrome.runtime call from it throws
  // "Extension context invalidated" from then on, permanently. The panel used
  // to swallow that silently and keep displaying its last recommendation with
  // a live-looking draft button, which is exactly what "the extension does
  // nothing" looks like from the outside. It has to say so and stop.
  if (extId) {
    // Re-fetch the worker: Chrome retires an idle MV3 service worker and
    // starts a fresh one, so the handle captured at startup can be dead by
    // now — and a dead handle silently skips the reload, making this check
    // pass by never running.
    const liveWorker = context.serviceWorkers()[0] || workers[0];
    await liveWorker.evaluate(() => chrome.runtime.reload()).catch((e) =>
      console.error(`  could not reload the extension: ${e.message}`)
    );
    // The panel's guaranteed heartbeat is refresh() every 8s — pollPage only
    // messages the worker when it has something to report, so a shorter wait
    // can end before anything has tried to talk to the dead extension.
    await roomPage.waitForTimeout(12000);
    const dead = await roomPage
      .evaluate(() => ({
        // Explicit null check: a missing element must read as "not shown",
        // not as !undefined === true.
        shown: document.getElementById("fm-dead")
          ? !document.getElementById("fm-dead").hidden
          : false,
        takeDisabled: document.getElementById("fm-take")?.disabled,
      }))
      .catch(() => ({ shown: false, takeDisabled: undefined }));
    console.log("\n--- after an extension reload (orphaned content script) ---");
    console.log(`  disconnected notice shown: ${dead.shown}, draft button disabled: ${dead.takeDisabled}`);
    if (!dead.shown || dead.takeDisabled !== true) {
      console.error("FAIL: a dead extension context left the panel looking live.");
      failed = true;
    }
  }

  await context.close();

  if (failed) {
    console.error("\n=== LOAD CHECK FAILED ===");
    process.exit(1);
  }
  console.log("\n=== LOAD CHECK PASSED: extension loads, popup renders and is interactive, options page correct, overlay injects ===");
}

main().catch((err) => {
  console.error("Uncaught error during load check:", err);
  process.exit(1);
});
