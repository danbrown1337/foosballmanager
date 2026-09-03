/*
 * Loads the actual unpacked extension into a real Chromium (via Playwright,
 * driving the browser this environment has bundled) and checks for load
 * errors, then opens the popup and options pages directly and checks for
 * JS errors in each. This is real verification that the extension loads
 * and runs — not just that its files exist.
 *
 * Not part of the extension itself; a one-off check for this build.
 */
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT_PATH = join(HERE, "..");
const CHROME = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";

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
  const errors = [];

  // Give the service worker a moment to register.
  await new Promise((r) => setTimeout(r, 1500));

  const workers = context.serviceWorkers();
  console.log(`Service workers registered: ${workers.length}`);
  if (workers.length === 0) {
    console.error("FAIL: no service worker registered — background.js did not load.");
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

  await context.close();

  if (failed) {
    console.error("\n=== LOAD CHECK FAILED ===");
    process.exit(1);
  }
  console.log("\n=== LOAD CHECK PASSED: extension loads, popup renders and is interactive, options page correct ===");
}

main().catch((err) => {
  console.error("Uncaught error during load check:", err);
  process.exit(1);
});
