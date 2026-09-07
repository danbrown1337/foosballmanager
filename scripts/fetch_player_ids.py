"""Bundle a canonical player index from Sleeper's public player map.

Sources spell players differently — "A.J. Brown" against "AJ Brown", "Travis
Etienne Jr." against "Travis Etienne" — and every mismatch silently drops that
player's ADP, leaving him on list position, which the engine then has to treat
as a real number. Normalising names solves most of it; a maintained roster
solves the rest, because it also carries current team and position, which is
what separates two players who genuinely share a name.

Sleeper's read API needs no key and no auth. Their docs ask that the full
player map be fetched no more than once a day, so this is a build step that
writes a compact file into the extension, not something the extension calls.

    python3 scripts/fetch_player_ids.py
"""
import json
import os
import sys
import urllib.request

SLEEPER_PLAYERS = "https://api.sleeper.app/v1/players/nfl"
OUT = os.path.join("extension", "data", "player_ids.json")

# The extension only needs identity. The full map is several megabytes of
# scouting fields that would be dead weight in a packaged extension.
KEEP_POSITIONS = {"QB", "RB", "WR", "TE", "K", "DEF"}


def fetch(url: str) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": "foosballmanager/1.0"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode("utf-8"))


def main() -> int:
    raw = fetch(SLEEPER_PLAYERS)
    players = []
    for pid, p in raw.items():
        pos = (p.get("position") or "").upper()
        if pos not in KEEP_POSITIONS:
            continue
        # Inactive players still matter: a board imported from a league list
        # can carry them, and dropping them here would only turn a resolvable
        # name back into an unresolvable one.
        name = p.get("full_name") or " ".join(
            filter(None, [p.get("first_name"), p.get("last_name")])
        )
        if not name:
            continue
        players.append({
            "id": pid,
            "name": name,
            "team": (p.get("team") or "").upper(),
            "pos": pos,
        })

    players.sort(key=lambda r: (r["name"], r["team"]))
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w") as f:
        json.dump({"source": "sleeper", "players": players}, f, separators=(",", ":"))

    size = os.path.getsize(OUT)
    print(f"Wrote {len(players)} players to {OUT} ({size / 1024:.0f} KB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
