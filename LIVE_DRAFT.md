# Running a live draft with Claude driving

For when you want Claude to actually click your picks in a real Yahoo
draft room, not just recommend them. This only works from **your own
machine** — the cloud session that builds this repo has no network access
to Yahoo at all (checked directly: even general sites like google.com are
blocked by its egress policy, not just Yahoo specifically), and can't see
or control your local browser either way.

**Scope, unchanged from the rest of this project:** drafting only. Trades
and roster/lineup moves are never automated — see `extension/README.md`
and this repo's root `README.md` for that standing rule.

**Honest limit:** nobody working on this project has ever seen Yahoo's
real draft room DOM. The read-only pieces (`browser_sync.py`) are solid —
matching rendered text can't go far wrong. The click-driving part below
leans on a live Claude session looking at the actual page and adapting,
specifically because a script written blind against a site nobody's seen
is more likely to click the wrong thing than an agent that checks first.
That's why the plan below starts with a visible confirm step before going
hands-off.

## 1. Relaunch Chrome with remote debugging on

Quit Chrome completely first — an already-running Chrome can't be attached
to; it has to be restarted with the flag.

```
macOS:    open -a "Google Chrome" --args --remote-debugging-port=9222
Linux:    google-chrome --remote-debugging-port=9222 &
Windows:  & "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222
```

## 2. Join the draft in that window

Log into Yahoo Fantasy and open the mock draft room in a tab. Copy the
room's URL from the address bar — you'll hand it to Claude.

Optional, recommended as a manual fallback: load the extension too —
`chrome://extensions` → Developer mode → **Load unpacked** → this repo's
`extension/` folder. Gives you a visible panel and an "I drafted this
player" button you can always fall back to by hand.

## 3. Get the repo and Claude running locally

```bash
git clone https://github.com/danbrown1337/foosballmanager
cd foosballmanager
pip install -r requirements.txt playwright --break-system-packages
claude
```

Drop `--break-system-packages` if pip doesn't recognize it — it's only
needed on some Linux setups with an externally-managed Python.

## 4. Brief Claude

Paste this once `claude` starts (fill in the draft room URL first):

```
I'm in a live Yahoo Fantasy Football mock draft, joined in Chrome running
with --remote-debugging-port=9222. This repo (foosballmanager) has a
tested draft engine and a read-only tool (fantasy_manager/browser_sync.py)
that attaches to that Chrome over CDP — no credentials involved, it drives
a session I already logged into myself.

Draft room URL: <PASTE URL HERE>

Your job: run the show for my picks. Concretely:
1. Start `python3 -m fantasy_manager.browser_sync watch --url <URL>` in
   the background — it auto-detects opponent picks and prints a
   recommendation every poll. Watch its output.
2. When I tell you "my turn" or "go", get the freshest recommendation
   (`python3 -m fantasy_manager.draft_assistant autopick`), tell me the
   player and the reasoning in one line, then use Playwright (connect
   over http://localhost:9222, find the Yahoo tab) to click that player
   on the real page. Use robust text-based locators (page.get_by_text),
   not guesses — actually look at the page's structure first
   (accessibility tree or a screenshot) since neither of us has seen this
   draft room before.
3. Stop before Yahoo's final confirm/submit click and tell me what you're
   about to do — I'll say "confirm" or "no" before you finish it, until
   we've both seen it work correctly a couple of times. After that I'll
   tell you if I want you to go fully hands-off on the confirm step too.
4. The instant I say "pause" or "stop" — mid-anything — stop immediately.
   No finishing "just this one pick" first.
5. Never touch trades or roster/lineup moves. Drafting only.
6. If --mode appear doesn't seem to be catching picks in the first
   minute, try --mode disappear, or run
   `dump --url <URL> --out page.html` to see what the room actually
   renders.
```

## Why this design, not a pre-written click script

The extension's own auto-draft (`extension/src/lib/domActions.js` +
`turnDetect.js`) already does unattended clicking, but it was built and
verified against a synthetic page, not Yahoo's real one — guessing at
selectors and "your turn" phrasing ahead of time is exactly the kind of
thing this project has repeatedly gotten wrong on the first try when it
couldn't watch the real thing run (see `HANDOFF.md`'s verification
posture section). A live Claude session that can read the actual page
before acting is strictly more reliable than either that extension or a
new script for this first real run. Once it's proven out, the extension's
own auto-draft becomes the better choice for future drafts — it doesn't
require a terminal or a second Claude session at all.

## Troubleshooting

- **"Couldn't attach to Chrome on port 9222"** — Chrome wasn't restarted
  with the flag, or something else is already using that port. Fully quit
  Chrome (not just close the window) and relaunch with the command above.
- **"Chrome landed on a Yahoo login page"** — log in in that window first;
  `browser_sync.py` never handles credentials, by design.
- **Nothing gets detected in `watch`** — try the other `--mode`, or run
  `dump` and check the saved `.txt` file for what the room actually
  renders.
