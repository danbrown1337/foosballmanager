# Handoff — morning of 2026-09-08

State at end of the 2026-09-07 session. HEAD `565ab65`, extension **v0.71.0**,
everything committed and pushed to `origin/main`.

```bash
cd extension && bash test/run_all.sh     # 209 tests + load check + DOM check
cd .. && python3 -m pytest               # 245 tests
```

Both green as of the last commit. The golden master (JS engine vs Python
engine, pick for pick) is inside `run_all.sh`.

---

## Read this first

**Your extension is loaded unpacked from this working directory.** There is no
staging boundary: the moment a file is edited, a browser reload picks it up,
including a half-finished edit. That is how a `unbound helpers — findPanelTab`
error reached the console tonight. **Only reload the extension on a version
that has been announced as committed.**

**Don't debug against a live draft.** Twice tonight a fix shipped mid-draft
made the draft worse — the frozen-list detector (v0.70.0) and the Picks-panel
swap (v0.70.0), both reverted in v0.70.1. Capture a room to a fixture and
iterate against that instead.

---

## The one finding that matters

Almost every bad pick this session traced to the same thing, and it is not the
scoring: **the board falls behind the room**, so the engine chooses from a pool
that is missing the players actually available, and the shortlist fills with
players who were drafted rounds ago.

Symptoms it produced, all downstream of that one cause:

- `queue: couldn't confirm <elite player> in the room` — correct, he was gone
- `Your turn — couldn't find "<name>" in this room, draft it manually`
- Kenneth Walker III taken while Jonathan Taylor and Christian McCaffrey were
  still on the room's list — the engine never saw them as options
- Yahoo autodrafting the pick, which is where the QB2s, the second tight ends
  and the D-graded receivers on every roster tonight came from

Fixes that landed against it: reading the room's own pick announcement, the
identity-based joins, the burst guard, the scroll-position guard, and holding
three-strikes to the marking threshold.

---

## Open, in the order I would do them

### 1. The cold-start hole — the Picks panel

**This is the fix for the finding above and it is written but disabled.**

`syncFromPicksPanel()` in `src/content/overlay.js`, gated behind
`PICKS_SYNC_ENABLED = false`.

The room keeps the complete pick list and will show it on request. Reading it
would close the hole that announcements cannot: picks made before the panel
loaded, or during a reload, are invisible forever otherwise. A draft reached
round 13 still recommending Derrick Henry, taken in round 3.

It is off because swapping the side panel over to Picks did not reliably swap
back, and the room was left showing Picks — which is where queue maintenance
reads what is queued, so the panel spent the rest of that draft reporting
`can't see the queue panel`.

**To finish it:** after restoring, confirm the Queue panel is actually showing
(`/Autodraft will pick from queue|Your queue is empty/` in the page text) and
click back again if not; bail out of the whole sync if it cannot be confirmed.
Note from the live DOM: only the *inactive* tab renders as a button, so when
Picks is showing the button says "Queue" and vice versa — verify that before
relying on `findPanelTab`.

### 2. `document.hidden` is the wrong signal

Chrome reports a tab hidden when its window is merely **covered** by another
window. That is why the panel kept saying "tab hidden" during drafts nobody
had navigated away from, and it gates real behaviour: sweeps, the queue depth,
and the turn warning.

The v0.70.0 attempt to test rendering directly (unchanged page text = frozen)
false-positived on a list that renders fine and was reverted to require
`document.hidden` as well. A better signal is needed. Candidate: compare the
set of player names visible before and after a scroll step — if it changed,
the list is rendering, whatever the visibility flag claims.

### 3. Was the early defence the engine or Yahoo?

The last draft finished with a kicker and a defence rostered before round 14,
which `defaultOnesieFloor` forbids and the queue's reservation also blocks
since v0.63. The visible log had scrolled past the evidence.

**v0.70.0 persists up to 200 log lines per room** in `chrome.storage.local`
under `fm_room_log`, keyed by the draft room id — but nothing surfaces them.
Adding a "copy full log" button beside "Copy decision log" in the popup would
have answered this in ten seconds, and will answer the next one.

### 4. Grade a draft the engine actually drafted

Every review so far — including two written by another model — has graded a
roster Yahoo's autodraft produced. `test/reviewRun2.test.js` pins the three
behaviours those reviews called failures and shows the engine refuses all
three. There is still **no measurement of our own engine drafting a full
draft**.

Popup → Team tab → **Grade this draft** produces the report from the decision
log. It needs one clean draft where the panel makes every pick.

---

## Quick reference

| Log line | Meaning |
|---|---|
| `Room announced X drafted.` | Working as intended — positive pick detection |
| `Board refreshed: … 0 put back` | Board healthy, no churn |
| `Partial view (N seen …) — freeing only` | Correct: too little of the board to mark anyone |
| `Ignored N players vanishing at once` | Burst guard caught a view change, not N picks |
| `This room has N teams, not the M in your settings` | Auto-detection overriding config for the session |
| `This room's format: …` | Roster shape read off the panel |
| `queue: couldn't confirm X` | Usually correct — X is drafted; a problem only if X is visibly in the room |
| `row present (0 cells, 0 controls…)` | Since v0.71 this counts as "drafted", not "button missing" |
| `degraded — …` in the header | Panel cannot read the list reliably |

Detected team count and roster format apply **per session and per room** and
are deliberately never written to settings — a mock is 12 or 14 teams with a
kicker, the real league is 10 with none.
