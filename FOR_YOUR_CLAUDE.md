# For your Claude

**If you're the person who was just handed this repo:** you don't need to
read this file. Open a Claude session (Claude Code, Cowork, or claude.ai
with this folder or its zip attached) and say:

> "Read `FOR_YOUR_CLAUDE.md` in this repo and walk me through it. I'm not
> technical — I want to be ready for my Yahoo fantasy football draft."

Everything below is addressed to Claude, not to you.

---

## Claude: read this before you start

You're helping someone get ready for a Yahoo Fantasy Football draft using
this repo. Assume they are **not technical**: no terminal, no Python, no
git, no editing config files. That assumption holds until they tell you
otherwise — plenty of people who say "I'm not technical" are perfectly
willing to paste a command, but let them volunteer it.

**Their goal is not to run this project.** It's to sit in their draft room
with good recommendations in front of them. The Chrome extension does that
with no terminal at all. That's the whole path. Don't widen it.

### Do not, unless they explicitly ask

- Don't route them to `pip`, `git clone`, or `python3 -m ...`. Path A in
  `SHARE_WITH_A_FRIEND.md` is for someone else.
- Don't send them to Yahoo's Fantasy Sports API application. It's gated,
  approval is per-developer, it takes days, and **the extension doesn't
  need it** — it reads the page they're already looking at.
- Don't have them install Node, npm, or Playwright. The extension has zero
  dependencies.
- Don't automate trades or roster/lineup moves, and don't offer to. That's
  a standing rule across this project — see `extension/README.md`. Drafting
  is the one deliberate exception, and only with the toggles below.

## Step 1 — install the extension

Full instructions are Path 0 in `SHARE_WITH_A_FRIEND.md`; follow those, but
drive it **one step at a time** and wait for them to confirm each one before
giving the next. The two places people get stuck:

- **Developer mode must be on first**, or "Load unpacked" isn't visible.
- **Load unpacked wants the `extension` folder**, the one containing
  `manifest.json` — not the repo folder above it, which is the more natural
  guess. If Chrome throws "Manifest file is missing or unreadable," this is
  why, every time.

Tell them not to move or delete the unzipped folder afterward: Chrome loads
the extension from that path, so moving it uninstalls it.

If they get stuck, ask for a screenshot of the `chrome://extensions` page
rather than asking them to describe what they see.

One platform check worth making early: this is a desktop-browser extension.
If they're planning to draft from the Yahoo phone app, it can't help them —
the draft room has to be open in a Chrome tab.

## Step 2 — get their league settings, conversationally

The extension's options page (**Details -> Extension options**) has a
**League** section: league name, number of teams, scoring, starter slots,
bench, IR, strategy, risk tolerance.

Do **not** read them those field names and ask them to fill it in. Instead:

- Ask them to open their league on Yahoo, go to **League -> Settings**, and
  send you a screenshot of that page. Read the values off it yourself and
  tell them exactly what to type in each field.
- If a screenshot isn't workable, ask in plain terms: how many teams, do
  they get a point per catch (that's PPR — half a point is half-PPR, none
  is standard), and how many of each position they start.

Two things that are easy to get wrong and expensive on draft day:

- **Kicker.** The bundled defaults come from a league with *no kicker slot*,
  so `K` defaults to 0. The engine treats an absent position as "never draft
  this," not "assume one." If their league starts a kicker and this is left
  at 0, it will never recommend one. Ask explicitly.
- **Flex.** That same league starts two W/R/T flex spots, which is unusual.
  Most leagues start one. Confirm the number rather than accepting the
  default.

## Step 2b — two things that break it, both invisible

Tell them both, because the panel can only report them after the fact:

- **The room's Players tab must stay open.** The queue star and the Draft
  button exist only in that list. With Board or Results showing there is
  nothing to click at all.
- **Nothing typed in the room's player search.** A filter narrows the list to
  a few rows, and everything the panel looks for afterwards is missing from
  it.

## Step 3 — explain what they'll see, before draft day

Have them open the extension's popup once so it isn't new to them mid-draft:
a recommended pick with a one-line reason, positional scarcity, and their
roster as it fills in. In the draft room itself a floating panel appears on
the page, with buttons to mark players as taken.

## Step 4 — auto-draft, and the honest caveat

`extension/README.md` documents two opt-in toggles, both off by default. In a
Yahoo draft room there is **no confirmation step** — the Draft button on a
player's row submits the pick immediately — so auto-draft on its own
highlights that button for them to press, and fully automatic presses it.

**Tell them plainly: this was built against a real Yahoo draft room, but only
one league's.** Turn detection works by searching the page's text for phrases like
"you're on the clock," and the confirm-button lookup works the same way.
Both phrase lists are editable in the extension's settings precisely because
the real room may word things differently.

So: have them run a **Yahoo mock draft** first, with fully-automatic OFF.
Watch whether the panel notices their turn. If it doesn't, look at what the
room actually says when it's their pick and add that wording to the
**Auto-draft turn phrases** list in settings. Same for the confirm button
text if they later want fully-automatic.

Leave fully-automatic off unless they ask for it and a mock draft has run
clean. Selecting a player is undoable; submitting a pick is not.

## Step 5 — the data is a snapshot, so say so

`extension/data/` bundles the ADP board and player notes. They were compiled
before the 2026 season, not pulled live, and no session has verified them
against a current source. Check today's date against that: the further into
the season, the more stale the rankings and the injury notes.

If there's time before their draft and you have web access, offer to check
current rankings and injury news and tell them what's changed. Only edit
`extension/data/*.json` if they want that — keep the existing structure,
don't invent players, and tell them exactly what you changed. If the draft
is imminent, skip it: the bundled list is a reasonable starting point.

## If they turn out to be comfortable with a terminal

Then `LIVE_DRAFT.md` is the other option: a local Claude session attached to
their Chrome over remote debugging, clicking picks while they watch. It
needs Python, Playwright, and a relaunched Chrome. Only raise it if they've
shown they're up for that — it is strictly more setup than the extension,
and the extension is what they'll want for every draft after the first.

## Day-of checklist

1. Extension loaded, league settings entered and double-checked (kicker,
   flex).
2. A mock draft run at least once, with the panel visibly recommending.
3. Draft room open in the Chrome tab where the extension is loaded.
4. Fully-automatic off unless they've deliberately chosen otherwise.
5. They know the recommendation is advice, and the confirm click is theirs.
