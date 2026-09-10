/*
 * The weekly panels' composition: parsed Yahoo pages in, the objects popup.js
 * renders out. Pure — no chrome.* and no I/O.
 *
 * This is split out from background.js on purpose. The composition is the seam
 * between three things that are each well tested on their own (the content
 * script's page text, weeklyParse.js, weekly.js), and a seam is exactly where a
 * port stops being covered by its parts. Leaving it inside the service worker
 * meant a test could only cover it by reimplementing it, which tests the copy
 * rather than the code — so background.js keeps the Chrome I/O and calls in
 * here for everything else, and the tests call the same functions the panel
 * does.
 *
 * SCOPE: recommend-only, like the rest of the project. These build reports.
 * Nothing here sets a lineup or places a claim.
 */
import {
  evaluateWaiverTargets,
  isFreeAgent,
  lineupChanges,
  optimalLineup,
  waiverClears,
  waiverSystem,
  weekLabel,
} from "../engine/weekly.js";

/** The league shape, defaulted the same way for both reports. */
function leagueShape(config) {
  return {
    starters: config?.roster?.starters || {},
    superflex: !!config?.league?.superflex,
  };
}

/* Every team's page in a league renders the same way and lives at the same
 * /f1/<league>/<id> shape, and nothing in the extension's config records which
 * id is yours — so with two team tabs open, the roster used is whichever
 * chrome.tabs.query returned first. That is a coin flip, and pricing pickups
 * against a rival's bench reads exactly like real advice. It can't be resolved
 * from the page, so it is counted and handed to the panel to say out loud. */
function rosterChoice(pages) {
  const rosters = (pages || []).filter((p) => p.kind === "roster");
  return { page: rosters[0] || null, otherRosterTabs: Math.max(0, rosters.length - 1) };
}

/**
 * The start/sit report for the open My Team page.
 *
 * Every failure is a reason rather than an empty result: "no lineup" and "I
 * could not find your team page" call for different things from the reader,
 * and a blank panel says neither.
 */
export function buildWeekReport({ pages, tabCount }, config, today = new Date()) {
  if (!tabCount) {
    return { error: "Open your Yahoo My Team page in a tab, then try again." };
  }

  // More than one f1/ tab can be open — the league page, a matchup, the player
  // list. Keep the one that reads as a roster instead of reporting failure from
  // whichever happened to be first.
  const { page, otherRosterTabs } = rosterChoice(pages);
  if (!page) {
    return {
      error: "Found a Yahoo tab but no roster on it. Open My Team and reload "
        + "the page, then try again.",
    };
  }

  const { starters, superflex } = leagueShape(config);
  const best = optimalLineup(page.rows, starters, { superflex });

  return {
    label: weekLabel(config, today),
    url: page.url,
    otherRosterTabs,
    starters: best.starters.map((a) => ({
      slot: a.slot,
      name: a.player ? a.player.name : null,
      pos: a.player ? a.player.pos : null,
      opponent: a.player ? a.player.opponent : null,
      status: a.player ? (a.player.bye ? "BYE" : a.player.status) : "",
      proj: a.player ? a.player.proj : null,
      emptyReason: a.emptyReason,
    })),
    bench: best.bench.map((p) => ({
      name: p.name, status: p.bye ? "BYE" : p.status,
    })),
    projected: Math.round(best.projected * 100) / 100,
    warnings: best.warnings,
    changes: lineupChanges(page.rows, best).map((c) => ({
      slot: c.slot,
      start: c.startPlayer ? c.startPlayer.name : null,
      bench: c.benchPlayer ? c.benchPlayer.name : null,
      reason: c.reason,
      moveOnly: c.moveOnly,
    })),
    // Whether the numbers are real matters more than the numbers: with no
    // projections this is position eligibility only, and the panel says so.
    hasProjections: page.rows.some((p) => p.proj !== null && p.proj !== undefined),
  };
}

/**
 * The waiver report, from the My Team page and the Players -> Available page.
 *
 * Both are needed and neither substitutes for the other. The wire alone gives a
 * list in whatever order Yahoo sorted it; the value of a pickup is what he adds
 * to *your* lineup, so the roster is what sets the bar he has to clear. With
 * only one open the report says which is missing, rather than ranking the wire
 * against nothing and calling it advice.
 */
export function buildWaiverReport({ pages, tabCount }, config, options = {}) {
  const { top = 8, today = new Date() } = options;
  if (!tabCount) {
    return {
      error: "Open your Yahoo My Team page and the Players -> Available page, "
        + "then try again.",
    };
  }

  const { page: rosterPage, otherRosterTabs } = rosterChoice(pages);
  const wirePage = (pages || []).find((p) => p.kind === "wire");
  if (!wirePage) {
    return {
      error: "No available-players page open. Go to Players -> Available in "
        + "Yahoo, set the Stats selector to \"Week N (proj)\", and try again.",
    };
  }
  if (!rosterPage) {
    return {
      error: "Found the player list but not your roster. Open My Team in "
        + "another tab as well — a pickup is only worth what it upgrades, so "
        + "there is nothing to measure against without it.",
    };
  }

  const { starters, superflex } = leagueShape(config);
  const [system, faab] = waiverSystem(config);

  // Yahoo's Available filter already excludes your own players, but the same
  // page with the filter set to "All players" does not — and a report telling
  // you to claim someone you already have reads exactly like a real one.
  const mine = new Set(rosterPage.rows.map((p) => p.name));
  const wire = wirePage.rows.filter((p) => !mine.has(p.name));

  const targets = evaluateWaiverTargets(wire, rosterPage.rows, starters, {
    superflex,
    faabRemaining: system === "faab" ? faab : null,
    top,
  });

  return {
    label: weekLabel(config, today),
    system,
    faab,
    rosterUrl: rosterPage.url,
    wireUrl: wirePage.url,
    otherRosterTabs,
    poolSize: wire.length,
    // Without projections on the wire page every gain is null and the list is
    // just Yahoo's own ordering. Worth saying out loud, because the usual cause
    // is a Stats selector left on actual points.
    hasProjections: wire.some((p) => p.proj !== null && p.proj !== undefined),
    targets: targets.map((t) => ({
      name: t.player.name,
      pos: t.player.pos,
      team: t.player.team,
      status: t.player.bye ? "BYE" : t.player.status,
      proj: t.player.proj,
      gain: t.gain,
      replaces: t.replaces ? t.replaces.name : null,
      drop: t.drop ? { name: t.drop.name, pos: t.drop.pos } : null,
      rationale: t.rationale,
      note: t.note,
      bidLow: t.bidLow,
      bidHigh: t.bidHigh,
      worthPriority: t.worthPriority,
      // "Add now" and "claim by Thursday" are different actions on different
      // clocks, so the distinction survives to the panel.
      rosterStatus: t.player.rosterStatus || null,
      freeAgent: isFreeAgent(t.player),
      clears: waiverClears(t.player),
    })),
  };
}
