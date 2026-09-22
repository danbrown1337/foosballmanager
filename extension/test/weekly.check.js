/* Browser fixture coverage for table parsing and the actual Weekly popup.
 * Run with Playwright installed: node test/weekly.check.js.
 * FM_CHROME optionally selects a local Chromium binary. No Yahoo account. */
import { chromium } from "playwright";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, extname } from "node:path";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const origin = "http://extension.test";
const yahoo = "https://football.fantasysports.yahoo.com/f1/123/";
const row = (name, pos, slot, proj, extra = "", status = "", available = "") => `<tr><td>${slot}</td><td><div class="ysf-player-name"><a>${name}</a><span>DET - ${pos}</span><span>${status}</span></div></td><td>${available}</td><td>${extra || "Sun"}</td><td>${proj}</td><td>9</td></tr>`;
const table = (rows, projection = "Proj Pts") => `<html><body><h2>Week 3</h2><table><thead><tr><th>Pos</th><th>Player</th><th>Status</th><th>Opp</th><th>${projection}</th><th>Bye</th></tr></thead><tbody>${rows}</tbody></table></body></html>`;
const teamHtml = table(row("Out Back", "RB", "RB", 18, "Sun", "O") + row("Bench Back", "RB", "BN", 14) + row("Flex Wide", "WR", "FLEX", 10) + row("Locked Wide", "WR", "BN", 30, "Final"));
const waiverHtml = table(row("Free Upgrade", "RB", "", 22, "Sun", "", "FA") + row("Owned Elsewhere", "RB", "", 99, "Sun", "", "Other Team"), "Fan Pts");
const browser = await chromium.launch({ executablePath: process.env.FM_CHROME || chromium.executablePath(), headless: true, args: ["--no-sandbox"] });
try {
  const page = await browser.newPage({ viewport: { width: 480, height: 780 } });
  const errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
  await page.route(origin + "/**", async (route) => {
    const path = resolve(root, "." + new URL(route.request().url()).pathname);
    if (!path.startsWith(root + "/")) return route.abort();
    try { await route.fulfill({ body: await readFile(path), contentType: ({ ".js": "text/javascript", ".html": "text/html", ".css": "text/css" })[extname(path)] || "application/json" }); }
    catch { await route.fulfill({ status: 404, body: "Not found" }); }
  });
  await page.addInitScript(({ teamHtml, yahoo }) => {
    window.saved = { fm_config: { league: { name: "Fixture League", scoring: "ppr" }, roster: { starters: { RB: 1, FLEX: 1 } } } };
    window.fixtureHtml = teamHtml;
    window.activeUrl = yahoo + "1?week=3";
    window.refreshFails = false;
    window.chrome = {
      action: { setBadgeText() {} },
      runtime: {
        getManifest: () => ({ version: "0.94.0" }),
        sendMessage: (msg, cb) => cb({ ok: true, result: { mine: [], scarcity: [], board: [], draftedCount: 0, total: 0 } }),
      },
      storage: { local: {
        get: async (key) => Object.hasOwn(window.saved, key) ? { [key]: window.saved[key] } : {},
        set: async (data) => Object.assign(window.saved, structuredClone(data)),
      } },
      tabs: {
        query: async () => [{ id: 1, url: window.activeUrl }],
        sendMessage: async (id, msg) => {
          try {
            const { parseWeeklyPage } = await import("/src/lib/weeklyImport.js");
            const snapshot = parseWeeklyPage(new DOMParser().parseFromString(window.fixtureHtml, "text/html"), { ...msg.options, url: window.activeUrl });
            return { ok: true, snapshot };
          } catch (err) { return { ok: false, error: err.message }; }
        },
      },
    };
    const realFetch = window.fetch;
    window.fetch = async (url, opts) => {
      if (!String(url).includes("fantasysports.yahoo.com")) return realFetch(url, opts);
      return { ok: !window.refreshFails, status: window.refreshFails ? 503 : 200, url,
        text: async () => String(url).includes("/players") ? window.waiverHtml : window.teamHtml };
    };
    window.teamHtml = teamHtml;
  }, { teamHtml, yahoo });
  await page.goto(origin + "/src/popup/popup.html");
  await page.click('[data-tab="weekly"]');
  await page.fill("#weeklySeason", "2026");
  await page.fill("#weeklyWeek", "3");
  await page.locator("#weeklyWeek").blur();
  await page.waitForFunction(() => !document.getElementById("weeklyRoster").disabled);
  await page.click("#weeklyRoster");
  await page.waitForFunction(() => document.getElementById("weeklyStatus").textContent.startsWith("Imported 4"));
  let report = await page.locator("#weeklyReport").innerText();
  assert.match(report, /Replace starter: Out Back/);
  assert.match(report, /RB: Bench Back/);
  assert.doesNotMatch(report, /RB: Locked Wide|FLEX: Locked Wide/);
  await page.evaluate(({ waiverHtml, yahoo }) => { window.fixtureHtml = waiverHtml; window.waiverHtml = waiverHtml; window.activeUrl = yahoo + "players?stat1=S_PW_3&status=A"; }, { waiverHtml, yahoo });
  await page.click("#weeklyWaivers");
  await page.waitForFunction(() => document.getElementById("weeklyStatus").textContent.startsWith("Imported 2"));
  report = await page.locator("#weeklyReport").innerText();
  assert.match(report, /Free Upgrade/);
  assert.doesNotMatch(report, /Owned Elsewhere/);
  // Header grids, actual/season points, missing projections and missing slots.
  const parsed = await page.evaluate(async ({ tableHtml, yahoo }) => {
    const { parseWeeklyPage } = await import("/src/lib/weeklyImport.js");
    const opts = { kind: "roster", season: 2026, week: 3, scoring: "ppr", url: yahoo + "1?week=3" };
    const parse = (html, options = opts) => parseWeeklyPage(new DOMParser().parseFromString(html, "text/html"), options);
    const results = [];
    for (const html of [tableHtml.replaceAll("Proj Pts", "Actual Pts"), tableHtml.replace("<td>RB</td>", "<td></td>"), "<html>Sign in</html>"]) {
      try { parse(html); results.push(false); } catch { results.push(true); }
    }
    const grouped = tableHtml.replace("<tr><th>Pos</th><th>Player</th><th>Status</th><th>Opp</th><th>Proj Pts</th><th>Bye</th></tr>", '<tr><th rowspan="2">Pos</th><th rowspan="2">Player</th><th rowspan="2">Status</th><th rowspan="2">Opp</th><th colspan="1">Projected</th><th rowspan="2">Bye</th></tr><tr><th>Fan Pts</th></tr>');
    return { rejects: results, grouped: parse(grouped).players[0].projected };
  }, { tableHtml: teamHtml, yahoo });
  assert.deepEqual(parsed.rejects, [true, true, true]);
  assert.equal(parsed.grouped, 18);
  const before = await page.evaluate(() => JSON.stringify(window.saved.fm_weekly));
  await page.evaluate(() => window.refreshFails = true);
  await page.click("#weeklyRefresh");
  await page.waitForFunction(() => document.getElementById("weeklyStatus").textContent.includes("503"));
  assert.equal(await page.evaluate(() => JSON.stringify(window.saved.fm_weekly)), before, "failed refresh must preserve the complete previous snapshot");
  await page.evaluate(() => window.refreshFails = false);
  await page.click("#weeklyRefresh");
  await page.waitForFunction(() => document.getElementById("weeklyStatus").textContent.startsWith("Refreshed 2"));
  await page.fill("#weeklyWeek", "4");
  await page.locator("#weeklyWeek").blur();
  await page.waitForFunction(() => document.getElementById("weeklyReport").textContent.includes("another week"));
  await page.fill("#weeklyWeek", "3");
  await page.locator("#weeklyWeek").blur();
  await page.waitForFunction(() => document.getElementById("weeklyReport").textContent.includes("RECOMMENDED LINEUP"));
  if (process.env.FM_SCREENSHOT) await page.screenshot({ path: process.env.FM_SCREENSHOT, fullPage: true });
  assert.deepEqual(errors, []);
  console.log("Weekly browser fixtures passed: roster/waiver import, header mapping, bad-data rejection, report UI, refresh success/failure and week changes.");
} finally { await browser.close(); }
