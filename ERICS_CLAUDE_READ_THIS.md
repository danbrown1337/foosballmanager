# Eric — read this first

This is a Yahoo Fantasy Football draft assistant. The part you want is a
Chrome extension: it sits on top of your Yahoo draft room, recommends a pick
with a one-line reason, keeps Yahoo's queue loaded with its next choices, and
— if you let it — clicks Draft for you. No terminal, no Python, no Yahoo API
application. About five minutes to set up.

## Hand this to Claude

Open a Claude session with this folder attached — Claude Code, or claude.ai
with the unzipped folder — and paste exactly this:

> Read `FOR_YOUR_CLAUDE.md` in this repo and walk me through it. I'm not
> technical — I want to be ready for my Yahoo fantasy football draft.

That file is written for Claude, not for you. It has the install steps, and
it tells Claude to read your league settings off a screenshot rather than
making you look up field names.

## If you'd rather not involve Claude

`SHARE_WITH_A_FRIEND.md`, Path 0. Same five minutes, done by hand.

## Three things to know before draft day

1. **Run a Yahoo mock draft first, with "Fully automatic" switched off.**
   Watch whether the panel notices your turn. Turn detection works by reading
   the room's own wording, and the phrase list is editable in settings if your
   league words it differently. Selecting a player is undoable; submitting a
   pick is not.

2. **Keep the draft window focused and on top.** Chrome throttles a tab whose
   window is merely covered — not just minimised — and a throttled tab can
   sleep through a turn. This is the one known limitation with no fix in the
   extension. Chat somewhere else, not over the draft.

3. **Leave the queue alone.** The panel keeps it loaded with the engine's next
   picks in order, and Yahoo drafts from it whenever the panel can't act — so
   it is the safety net for point 2. Names you add by hand will disappear when
   the plan no longer wants them. If you want a specific player, draft him.

## What it deliberately won't do

Trades, lineup changes, waiver claims — nothing outside the draft, and it
won't offer. Drafting is the one automated exception, and only with the
toggles you turn on yourself.

## Fair warning on the data

`extension/data/` bundles an ADP board and researched player notes compiled
before the 2026 season. They are a snapshot, not a live feed, and they go
stale. If your league's draft room publishes its own player list, the
extension prefers that — but the risk/breakout notes are still from whenever
they were written. Ask your Claude to sanity-check the top of the board
against current rankings if there's time.

Built and tested against real Yahoo draft rooms, but only a handful of
leagues' worth. Mock first.
