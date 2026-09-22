# Weekly management — extension v0.94.0

The old roster manager could count positions and show preseason ADP, but it
could not manage an in-season lineup. Its waiver list also included players
owned by rivals. The Weekly tab now supplies a separate in-season workflow.

## Get your team connected

1. Update the checkout to the branch/release containing v0.94.0. On desktop
   Chrome, reload Fantasy Manager at `chrome://extensions`, then reload Yahoo.
2. Check extension **Settings** against your Yahoo league: scoring and every
   starting slot. Turn Practice mode off. The default is one QB, two RBs, two
   WRs, one TE, two W/R/T flex spots and one defense, with no kicker.
3. Open **your team's roster page** in Yahoo and select the NFL week you want
   to manage. Open the extension → **Weekly**, set the season/week and click
   **Import this team**. Choose the season that Yahoo is showing; where the
   page does not expose a season, this selection is your confirmation.
4. Open the same league's **Players** page. Select **Available Players** and
   the chosen week's **projected** stats, then click **Import available players**.
   Import additional pages/positions (including defense and kicker if needed).
   The list covers only those imported pages, not the entire waiver pool.
5. Read the report and make any chosen moves in Yahoo. **Copy weekly report**
   gives you a shareable text report for review in chat.

The extension requires desktop Chrome; it does not run inside the Yahoo iPhone
app. A phone screenshot of the roster, bench and available players can still be
reviewed in chat, but is not an automatic connection to the extension.

## What it does

- Flags out/bye starters and questionable/doubtful players to monitor.
- Finds the best full lineup from current weekly projections, honoring
  position eligibility, multi-position players, flex slots and known locks.
- Leaves locked starters in their existing slots and excludes locked bench
  players, unavailable players and players still in IR slots.
- Ranks available-player upgrades by their marginal effect on the complete
  lineup; each suggestion is an alternative evaluated against today's roster.
- Requires positive availability evidence from Yahoo. A high preseason rank
  or absence from a rival-roster import is not proof that someone is available.
- Keeps the last successful imports if parsing, sign-in or refresh fails.

## Keep the plan current

**Refresh saved pages** reloads the exact imported Yahoo pages with your browser
session and recalculates the report. It is an on-demand refresh, not a scheduled
service. For a new week, select that week in Yahoo and import again. Captures
older than 24 hours are rejected; refreshing one waiver page cannot make older
pages appear fresh. Recheck injury designations and locks near kickoff even if
an import is less than 24 hours old.

Data stays in this Chrome profile's local extension storage, separately from
mock/draft state and the older trade-roster imports. This Git checkout contains
no current personal roster or Yahoo session.

## Limits and troubleshooting

- **No weekly projection column / wrong stats:** select the specific week's
  projected points. Season totals and actual points are not weekly forecasts.
  The player-page importer recognizes Yahoo's `stat1=S_PW_<week>` view and
  reads fantasy points by header; the team page needs an explicit projection
  header. Unknown layouts fail with a message instead of guessing columns.
- **No lineup slot / no player rows:** use the full team table in a signed-in
  Yahoo tab. If Yahoo's layout has changed, capture the table HTML for a parser
  fixture; don't silently replace a full roster with a partial import.
- **Unknown lock times:** the report says to verify Yahoo still permits each
  change. It can recognize explicit game timestamps and final/in-progress
  markers, but does not guess kickoff times from ambiguous day/time text.
- **Missing projections:** coverage and lineup comparisons are provisional.
  A missing value is not zero and is never replaced with draft ADP.
- **Drops, IR moves, FAAB and trades:** no automatic transactions. A one-week
  streaming upgrade is not evidence that a valuable season-long player should
  be dropped. Claim deadlines, roster room and season value need review.
- **Live compatibility:** validated with synthetic Yahoo-shaped browser
  fixtures, not this user's authenticated Yahoo page. First real import is
  still required to confirm the live table layout and diagnose the actual team.

## Verification

`node --test extension/test/weeklyManager.test.js` covers two flex slots,
overlapping eligibility, locks, injuries/byes, zero/missing projections,
ownership, freshness, league/week isolation and multi-page refresh semantics.

`node extension/test/weekly.check.js` (with Playwright/Chromium installed)
exercises table parsing and the actual popup: import, report rendering,
refresh success/failure and week changes. `FM_CHROME` may select a local browser.
It is also included in the browser portion of `extension/test/run_all.sh`.
