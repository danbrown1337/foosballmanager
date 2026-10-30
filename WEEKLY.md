# The weekly process

Drafting is one day. The season is eighteen weeks of two questions: **who do I
start**, and **who's worth picking up**. This is how the tool answers both, and
where in the week each one matters.

The short version, run twice a week:

```bash
# 1. Import what Yahoo currently shows for your team
python3 -m fantasy_manager.browser_sync week --url <your My Team page URL>

# 2. Read the whole week in one report
python3 -m fantasy_manager.roster_manager week
```

Everything else on this page is detail behind those two commands.

## What it does and doesn't decide

It recommends. You execute. Nothing in this project sets a lineup, places a
claim, drops a player, or sends a trade — that line is drawn deliberately and
it holds here too. Drafting was the one opt-in exception, and only in the
Chrome extension.

That isn't caution for its own sake. The lineup advice is only as good as a
page-scrape it cannot verify, and a script that quietly sets lineups on a bad
parse loses you weeks before you notice. A recommendation you read takes ten
seconds to sanity-check. Set it yourself.

## One-time setup

Two things in your profile's `league.yaml` (`profiles/<you>/league.yaml`, not
the template in `config/`):

```yaml
season:
  week1_start: "2026-09-10"   # kickoff of Week 1; everything derives the week from this

waivers:
  system: faab                # faab | priority — check League -> Settings on Yahoo
  faab_budget: 100
  faab_remaining: 100         # update as you spend
```

If `week1_start` is missing the report says "Week unknown" rather than guessing,
because a Week 3 lineup set in Week 4 is worse than no advice. And the waiver
system is printed on every report, so if it assumed wrong you'll see it the
first time rather than after a bid you couldn't make.

Once, so waivers can tell a free agent from someone's bench player:

```bash
python3 -m fantasy_manager.browser_sync sync --url <League -> Rosters URL>
```

Without that file, `waivers` says so and falls back to "best available", which
will happily suggest players who are already rostered.

## The rhythm

Waiver run days vary by league — check **League -> Settings**; Yahoo's common
default processes claims overnight into Wednesday. Set yours as `run_day` in
`league.yaml`. The shape below assumes that default; shift it to match.

### Tuesday — read the wire

Waiver claims for the coming week are usually due late Tuesday. This is the one
that rewards being early, because it's the only decision in the week made
against a deadline rather than a kickoff.

```bash
python3 -m fantasy_manager.browser_sync week --url <My Team URL>
python3 -m fantasy_manager.browser_sync week --free-agents --url <Players -> Available URL>
python3 -m fantasy_manager.roster_manager waivers
```

Or, without a terminal: open both pages in tabs, click the extension, and press
**Waiver targets** on the Week tab. Same ranking, same numbers — the JS engine
is diffed against this one field for field. If you have another team's page
open as well, the panel says so and names the roster it used: every team in a
league renders the same way, so it cannot tell which one is yours.

You get, per target: the projected gain over the player they'd actually
replace in your lineup, a suggested drop, either a FAAB bid range or a "worth
your priority" verdict, and — when the page said — whether the player is a free
agent you can add right now or is on waivers with a claim date. Those are
different actions and the deadline only applies to one of them.

**Read the gain, not the ranking.** A player is worth a claim because he
upgrades a slot you're starting, not because he's the best name available. The
tool measures against the weakest player currently holding a slot he could
take, which is why a good running back can show a smaller gain than a mediocre
tight end — you already have running backs.

### Wednesday — see what landed

Claims processed. Re-import, and check whether the plan survived contact:

```bash
python3 -m fantasy_manager.browser_sync week --url <My Team URL>
python3 -m fantasy_manager.roster_manager week
```

Anything you missed is now a free agent, first-come — the same `waivers`
command ranks those too.

### Thursday — the lock nobody remembers

**A player in Thursday night's game locks at kickoff.** If the report tells you
to start someone playing Thursday, that has to happen Thursday afternoon, not
Sunday morning. This is the single most common way a good recommendation turns
into zero points.

```bash
python3 -m fantasy_manager.roster_manager lineup
```

Or press **Read my team page** on the extension's Week tab.

Check the `OPP` column against the Thursday matchup before you close the laptop.

### Sunday morning — the one that counts

Inactives are announced about 90 minutes before kickoff, and that is when
`Questionable` becomes `Out`. Re-import then, not the night before:

```bash
python3 -m fantasy_manager.browser_sync week --url <My Team URL>
python3 -m fantasy_manager.roster_manager lineup
```

Read the flags at the bottom of the report:

- `is BYE` / `is O` in a starting slot — that slot scores zero as it stands.
  Always act on these.
- `Q` next to a starter — expected to play, flagged so you can decide. The
  tool starts them; Yahoo's projection already discounts them somewhat.
- `is D and left out` — Doubtful players are excluded by default, because
  Yahoo's projection often doesn't zero them and trusting the number would
  quietly start someone who sits. `--allow-doubtful` reconsiders them.
- `Move X from W/R/T to TE` — nobody is benched, but the move still has to
  happen. Leave a tight end in a flex spot and the TE slot sits empty.

### Monday — nothing

Deliberately. There is no decision to make on a Monday that can't wait for
Tuesday's wire, and the temptation to churn a roster after a bad Sunday is how
you drop the player who scores 20 next week.

## Reading the start/sit report

```
SLOT    PLAYER                  POS  OPP     ST   PROJ
QB      Josh Allen              QB   vs NYJ  —    21.80
...
                                             TOTAL 127.60
                                             AS SET 120.96   (+6.64 from the changes below)
        ^ this should match the projected total on your Yahoo page.

Changes to make in Yahoo:
  - FLEX: start Jaylen Waddle, bench Tank Bigsby  (Tank Bigsby is BYE)
  - Move  Trey McBride           (move from W/R/T to TE)
```

**AS SET is the line to check once.** It sums the projections for whoever Yahoo
currently has starting, which is exactly what Yahoo's own projected total for
the week shows. If those two numbers disagree, the projection column is being
read wrong — and that is invisible everywhere else in the report. The gap
between TOTAL and AS SET is what the changes are worth.

The **Changes** block is the actionable part. The lineup above it is what you
end up with; the changes are what you have to click to get there.

The lineup is the highest-projecting *legal* one — every slot filled by
someone eligible for it, nobody on bye or ruled out. Where the league runs both
a flex and a superflex, the narrower slot is filled first on purpose; fill the
wider one first and it swallows the only eligible running back and strands the
other slot.

## Matchup: what the defence has actually allowed

`lineup` grows a **MATCH** column once there's enough history, and
`matchup` prints the whole table:

```bash
python3 -m fantasy_manager.roster_manager matchup
python3 -m fantasy_manager.roster_manager matchup --pos RB
```

**It is never folded into PROJ, and it never reorders your lineup.** That is
the whole design. Yahoo's projection already prices some matchup in — nobody
knows how much — so an adjustment layered on top double-counts by an unknown
amount and quietly changes which nine players you start. The lineup would still
look reasonable, which is what makes it the worst kind of bug. So the column
sits beside the projection and you decide. A test pins that `weekly.py` never
imports `matchup.py`.

**Where the numbers come from: your own imports, and nothing else.** Every
`browser_sync week` saves a snapshot, and from week 2 those rows carry the
points each player actually scored plus the defence he faced. Accumulate them
and you have a real record.

Three consequences worth being blunt about:

- **It says nothing for the first few weeks.** A defence needs three games and
  four players at a position before it's rated. Two games is a result, not a
  pattern, and a confident ranking off two games is worse than none because
  it'll be believed.
- **It cannot be backfilled.** A week you didn't import is a week that isn't
  counted, ever. That is the argument for importing every week from the start.
- **It is not "points allowed to RBs".** That statistic is a league-wide total
  over every back in the NFL, and this has no such data. What it measures is
  *the average points a fantasy-relevant player at that position scored against
  that defence* — your league's rosters and its wire. Comparable across
  defences, which is all a matchup read needs, but a different number from the
  one on a stats site, and it's labelled that way.

Kickers and defences aren't rated at all: their scoring turns on game script
and their own offence, not on who they're facing.

Rows from players who were Out, Doubtful or on bye are excluded. A zero from
someone who didn't play is about his hamstring, and counting it would mark
every defence that happened to face an injured starter as tough.

## When it can't answer

The report tells you which of these it's in rather than papering over it:

- **No weekly data imported** — it falls back to your post-draft roster, which
  is enough to catch a bye or an empty slot and *not* enough to rank two
  healthy players. It says so at the top.
- **No projection for a player** — he's slotted on position eligibility alone
  and named in a warning. "No information" is not treated as "projected zero".
- **No league rosters imported** — `waivers` says its pool is "your roster
  only" and is a best-available list, not a wire.

## The part to verify once

`browser_sync week` parses Yahoo's rendered page text. It has been checked
against a real My Team page (2026 week 1, captured as
`tests/fixtures/yahoo_myteam_week1.txt`), including the cross-check that
matters: summing the parsed projections for the nine players Yahoo had starting
reproduced Yahoo's own displayed projected total to the cent.

The available-players page is captured too, and it does **not** share My Team's
columns — it has a Roster Status column and an extra GP\* column before Bye.
Rows the My Team capture lacked (kicker, IR, bye, Out) are covered by a third
fixture that is *constructed* from that layout rather than captured — a real
test of the parser, not evidence Yahoo renders them that way. A superflex slot
and the SUSP/PUP designations are not covered at all.

**One thing to set on the players page**: the Stats selector at the top must say
**Week N (proj)**. That column is what gets read as the projection; leave it on
actual points and the waiver advice is comparing last week's results against
this week's forecasts.

So the first time you run it, the import prints every field it extracted:

```
PLAYER                  POS  TM   SLOT   ST   OPP     PROJ
Josh Allen              QB   BUF  QB     —    vs NYJ  21.80
```

Check that table against the page once. A projection column read off the wrong
number is invisible in a lineup recommendation and obvious in a table.

You no longer have to add the column up yourself: `lineup` prints an **AS SET**
total, which is exactly the sum for whoever Yahoo currently has starting, and
the extension's Week tab prints the same number. Compare it to the projected
total your My Team page displays. Those two agreeing is the only end-to-end
evidence the parser is reading the right column — Yahoo's total is not in the
page text, so nothing can check it automatically.

If it's wrong, copy the page and save it (`pbpaste > page.txt` on macOS), then
`parse_weekly_text` in `fantasy_manager/browser_sync.py` is what needs
adjusting. Do not save the page as HTML and use `--from-file`: that passes raw
markup through, and the parser matches rendered text.

No Chrome automation needed for any of this, incidentally: `--from-text` reads
a file of rows you copied off the page by hand, and takes the identical path
through the parser.

## What isn't here yet

- **A matchup read from outside your own league.** What's here is built from
  your imports only — see below. It is not the league-wide "points allowed to
  RBs" you'd find on a stats site, and no data source in this repo provides
  that.
- **Trade offers as part of the weekly loop.** `trade_targeter.py` exists and
  works, but it isn't wired into `week` — it runs on season-long value, not
  this week's numbers.
- **`overachievers` in the extension.** It stays CLI-only. Start/sit, waivers
  and the bye outlook are in both.
