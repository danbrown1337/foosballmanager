#!/usr/bin/env python3
"""
Roster import via your own browser, for while Yahoo API access is pending.

WHY THIS EXISTS: Yahoo gates Fantasy API access behind an application review.
Until that lands, `yahoo_client.py` can't fetch anything, and rosters have to
be typed into my_roster.csv and league_rosters.csv by hand. This reads the
same data off the league pages you're already looking at.

HOW IT AVOIDS TOUCHING YOUR PASSWORD: it attaches to a Chrome you started and
logged into yourself, over the DevTools protocol. No credentials are entered,
stored, or seen by this code — it drives a session you already opened.

    # Quit Chrome fully first, then start it with debugging enabled:
    #   macOS:  /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome \\
    #             --remote-debugging-port=9222
    #   Linux:  google-chrome --remote-debugging-port=9222
    #   Windows: chrome.exe --remote-debugging-port=9222
    # Log into Yahoo Fantasy in that window, then:

    python3 -m fantasy_manager.browser_sync dump --url <league rosters URL> --out page.html
    python3 -m fantasy_manager.browser_sync parse --from-file page.html
    python3 -m fantasy_manager.browser_sync sync --url <league rosters URL>   # both at once

PARSING STRATEGY: this matches Yahoo's rendered text ("Jahmyr Gibbs Det - RB")
rather than CSS selectors. Class names on Yahoo's fantasy pages are generated
and change without notice; that "Name TEAM - POS" rendering has been stable for
years and survives markup churn. It also means `parse` works on text you copied
by hand, with no automation involved at all — see `parse --from-text`.

SCOPE: read-only, and deliberately so. Nothing here submits a trade, adds, or
drops. That matches the decision already made in trade_targeter.py: Yahoo's own
API is read-only, and scripting real actions against your league risks looking
like bot activity. Offers still get sent by hand.
"""
from __future__ import annotations

import argparse
import csv
import os
import re
import sys
from collections import defaultdict

from fantasy_manager.board import POS_ALIASES, ROOT

DEFAULT_CDP_PORT = 9222

# "Jahmyr Gibbs Det - RB", "Seattle Seahawks Sea - DEF", "Taysom Hill NO - TE,QB"
# The " - " separator preceded by a 2-3 letter team abbreviation is the anchor;
# the name is whatever precedes it on the line.
PLAYER_LINE = re.compile(
    r"^(?P<name>.{2,40}?)\s+"
    r"(?P<team>[A-Za-z]{2,3})\s*-\s*"
    r"(?P<pos>[A-Za-z]{1,3}(?:\s*,\s*[A-Za-z]{1,3})*)\b"
)

# Yahoo appends injury/status designations after the position.
STATUS_SUFFIXES = {"Q", "D", "O", "IR", "SUSP", "PUP", "NA", "GTD"}


def normalize_position(raw: str) -> str:
    """Yahoo lists every eligible position ("TE,QB"); downstream code matches a
    single one, so keep the first — same rule the API client applies."""
    first = raw.split(",")[0].strip().upper()
    return POS_ALIASES.get(first, first)


def looks_like_a_player(name: str) -> bool:
    """Filter out chrome, headers, and stat rows that happen to contain a dash."""
    name = name.strip()
    if len(name) < 3 or not any(c.isalpha() for c in name):
        return False
    if any(c.isdigit() for c in name):
        return False
    # Roster slot labels ("QB", "W/R/T", "BN") lead the row in Yahoo's markup.
    if name.upper() in {"QB", "RB", "WR", "TE", "K", "DEF", "BN", "IR", "W/R/T", "FLEX"}:
        return False
    return True


def parse_roster_text(text: str) -> list[dict]:
    """Extract player rows from rendered league/roster page text.

    Pure and side-effect free so it can be developed against a saved page
    without repeatedly hitting Yahoo.
    """
    rows: list[dict] = []
    seen: set[str] = set()

    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        match = PLAYER_LINE.match(line)
        if not match:
            continue

        # Periods are deliberately NOT stripped: the ADP board carries them in
        # "Marvin Harrison Jr.", "A.J. Brown", "Amon-Ra St. Brown", and an exact
        # name match is what attaches a player's value.
        name = match.group("name").strip(" ,-–—")
        # A roster-slot label can precede the name in the same line ("BN Puka
        # Nacua LAR - WR"); drop it rather than folding it into the name.
        parts = name.split(None, 1)
        if len(parts) == 2 and not looks_like_a_player(parts[0]) and parts[0].upper() in {
            "QB", "RB", "WR", "TE", "K", "DEF", "BN", "IR", "W/R/T", "FLEX"
        }:
            name = parts[1]

        if not looks_like_a_player(name) or name in seen:
            continue

        pos = normalize_position(match.group("pos"))
        if pos in STATUS_SUFFIXES and pos not in {"K", "D"}:
            continue

        seen.add(name)
        rows.append({"name": name, "pos": pos, "team": match.group("team").upper()})

    return rows


def parse_league_page(text: str) -> dict[str, list[dict]]:
    """Split a multi-team page into {team_name: [players]}.

    Team headings are lines that carry no player match and read like a name;
    players following one belong to it. A page with no headings comes back
    under a single "" key, which the caller can name explicitly.
    """
    teams: dict[str, list[dict]] = defaultdict(list)
    current = ""
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        players = parse_roster_text(stripped)
        if players:
            teams[current].extend(players)
        elif 3 <= len(stripped) <= 40 and not any(c.isdigit() for c in stripped):
            current = stripped
    return dict(teams)


# --- browser attachment -----------------------------------------------------

def fetch_page_text(url: str, port: int = DEFAULT_CDP_PORT) -> tuple[str, str]:
    """Attach to an already-running, already-logged-in Chrome and read a page.

    Returns (rendered_text, html). Playwright is imported here rather than at
    module scope so the parsing above stays usable — and testable — without it.
    """
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        raise SystemExit(
            "Playwright isn't installed. Install it with:\n"
            "  pip install playwright --break-system-packages\n"
            "The browser itself is the Chrome you're already running — no "
            "extra download is needed."
        )

    with sync_playwright() as p:
        try:
            browser = p.chromium.connect_over_cdp(f"http://localhost:{port}")
        except Exception as err:
            raise SystemExit(
                f"Couldn't attach to Chrome on port {port}: {err}\n\n"
                "Quit Chrome completely, then relaunch it with:\n"
                f"  --remote-debugging-port={port}\n"
                "and log into Yahoo Fantasy in that window before rerunning.\n"
                "(An already-running Chrome started without that flag can't be "
                "attached to — it has to be restarted.)"
            )

        context = browser.contexts[0] if browser.contexts else browser.new_context()
        page = context.new_page()
        try:
            page.goto(url, wait_until="networkidle", timeout=60_000)
            if "login" in page.url or "signin" in page.url.lower():
                raise SystemExit(
                    "Chrome landed on a Yahoo login page. Log in in that browser "
                    "window, then rerun — this tool never handles credentials."
                )
            return page.inner_text("body"), page.content()
        finally:
            page.close()


# --- commands ---------------------------------------------------------------

def write_my_roster(rows: list[dict]) -> str:
    path = os.path.join(ROOT, "my_roster.csv")
    with open(path, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["name", "pos", "team"])
        w.writeheader()
        w.writerows([{k: r[k] for k in ("name", "pos", "team")} for r in rows])
    return path


def write_league_rosters(teams: dict[str, list[dict]]) -> str:
    path = os.path.join(ROOT, "league_rosters.csv")
    with open(path, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["team_name", "manager", "name", "pos", "team"])
        w.writeheader()
        for team_name, players in teams.items():
            for p in players:
                w.writerow({"team_name": team_name or "Unknown", "manager": "", **p})
    return path


def report(rows: list[dict]) -> None:
    """Flag names the ADP board doesn't know — they carry no value, so they're
    invisible to the trade generator and the waiver view."""
    from fantasy_manager.board import load_players

    board = {p.name for p in load_players()}
    unmatched = sorted({r["name"] for r in rows if r["name"] not in board})
    if unmatched:
        print(f"\n{len(unmatched)} player(s) don't match a name on the ADP board:")
        for name in unmatched[:20]:
            print(f"  {name}")
        if len(unmatched) > 20:
            print(f"  ... and {len(unmatched) - 20} more")
        print("Deep bench names are expected. A starter here means the spelling "
              "differs and is worth aliasing.")


def _read(path: str) -> str:
    with open(path, encoding="utf-8", errors="replace") as f:
        return f.read()


def _no_players_found() -> None:
    print("No players parsed from that page.", file=sys.stderr)
    print(
        "\nThe parser looks for Yahoo's \"Name TEAM - POS\" rendering. If the "
        "page uses something else, save it and inspect it:\n"
        "  python3 -m fantasy_manager.browser_sync dump --url <url> --out page.html\n"
        "then rerun with --from-file page.html. The saved file is the fastest "
        "way to get the parser corrected against what Yahoo actually renders.",
        file=sys.stderr,
    )


def cmd_dump(args):
    text, html = fetch_page_text(args.url, args.port)
    with open(args.out, "w", encoding="utf-8") as f:
        f.write(html)
    text_path = os.path.splitext(args.out)[0] + ".txt"
    with open(text_path, "w", encoding="utf-8") as f:
        f.write(text)
    print(f"Saved HTML to {args.out} and rendered text to {text_path}.")
    found = parse_roster_text(text)
    print(f"Parser found {len(found)} player(s) in it.")
    if not found:
        _no_players_found()


def cmd_parse(args):
    text = _read(args.from_file or args.from_text)
    if args.from_file and args.from_file.endswith((".html", ".htm")):
        # Crude tag strip: enough to recover the visible text from a saved page.
        text = re.sub(r"<(script|style)[^>]*>.*?</\1>", " ", text, flags=re.S | re.I)
        text = re.sub(r"<[^>]+>", "\n", text)

    if args.mine:
        rows = parse_roster_text(text)
        if not rows:
            _no_players_found()
            sys.exit(1)
        print(f"Parsed {len(rows)} player(s) -> {write_my_roster(rows)}")
        report(rows)
        return

    teams = parse_league_page(text)
    all_rows = [p for players in teams.values() for p in players]
    if not all_rows:
        _no_players_found()
        sys.exit(1)
    print(f"Parsed {len(all_rows)} player(s) across {len(teams)} team(s) "
          f"-> {write_league_rosters(teams)}")
    report(all_rows)


def cmd_sync(args):
    text, _ = fetch_page_text(args.url, args.port)
    if args.mine:
        rows = parse_roster_text(text)
        if not rows:
            _no_players_found()
            sys.exit(1)
        print(f"Synced {len(rows)} player(s) -> {write_my_roster(rows)}")
        report(rows)
        return

    teams = parse_league_page(text)
    all_rows = [p for players in teams.values() for p in players]
    if not all_rows:
        _no_players_found()
        sys.exit(1)
    print(f"Synced {len(all_rows)} player(s) across {len(teams)} team(s) "
          f"-> {write_league_rosters(teams)}")
    report(all_rows)


def main():
    parser = argparse.ArgumentParser(
        description="Import rosters from your own logged-in Chrome (read-only)")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_dump = sub.add_parser("dump", help="Save a page's HTML and text for inspection")
    p_dump.add_argument("--url", required=True)
    p_dump.add_argument("--out", default="yahoo_page.html")
    p_dump.add_argument("--port", type=int, default=DEFAULT_CDP_PORT)
    p_dump.set_defaults(func=cmd_dump)

    p_parse = sub.add_parser("parse", help="Parse a saved page or pasted text into CSVs")
    src = p_parse.add_mutually_exclusive_group(required=True)
    src.add_argument("--from-file", help="Saved .html (or .txt) page")
    src.add_argument("--from-text", help="Plain text file of copied roster rows")
    p_parse.add_argument("--mine", action="store_true",
                         help="Write my_roster.csv instead of league_rosters.csv")
    p_parse.set_defaults(func=cmd_parse)

    p_sync = sub.add_parser("sync", help="Attach to Chrome, read a page, write the CSVs")
    p_sync.add_argument("--url", required=True)
    p_sync.add_argument("--mine", action="store_true",
                        help="Write my_roster.csv instead of league_rosters.csv")
    p_sync.add_argument("--port", type=int, default=DEFAULT_CDP_PORT)
    p_sync.set_defaults(func=cmd_sync)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
