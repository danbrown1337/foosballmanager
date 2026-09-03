#!/usr/bin/env python3
"""
Converts the shared Python data (data/*.csv, fantasy_manager/bye_weeks.py)
into JSON the Chrome extension can fetch with no dependencies of its own.

The extension has no Python runtime and no filesystem access beyond its own
bundled files, so it can't read the CSVs directly — this is the one-time (or
whenever data/ changes) conversion step that keeps the extension's data in
sync with the CLI's, rather than hand-duplicating it.

Run from the repo root:
    python3 scripts/build_extension_data.py
"""
from __future__ import annotations

import csv
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, "extension", "data")


def convert_adp():
    src = os.path.join(ROOT, "data", "adp_2026_ppr.csv")
    with open(src) as f:
        rows = list(csv.DictReader(f))
    players = [
        {
            "rank": int(r["rank"]),
            "name": r["name"],
            "team": r["team"],
            "pos": r["pos"],
            "adp": float(r["adp"]),
        }
        for r in rows
    ]
    return players


def convert_notes():
    src = os.path.join(ROOT, "data", "player_notes_2026.csv")
    with open(src) as f:
        rows = list(csv.DictReader(f))
    notes = {
        r["name"]: {"tag": r["tag"], "adjustment": float(r["adjustment"]), "note": r["note"]}
        for r in rows
    }
    return notes


def convert_bye_weeks():
    # Imported rather than re-parsed so this can never drift from the CLI's
    # own copy — there is exactly one BYE_WEEKS dict in the whole project.
    import sys

    sys.path.insert(0, ROOT)
    from fantasy_manager.bye_weeks import BYE_WEEKS

    return BYE_WEEKS


def main():
    os.makedirs(OUT_DIR, exist_ok=True)

    players = convert_adp()
    notes = convert_notes()
    byes = convert_bye_weeks()

    with open(os.path.join(OUT_DIR, "adp_2026_ppr.json"), "w") as f:
        json.dump(players, f, indent=2)
    with open(os.path.join(OUT_DIR, "player_notes_2026.json"), "w") as f:
        json.dump(notes, f, indent=2)
    with open(os.path.join(OUT_DIR, "bye_weeks.json"), "w") as f:
        json.dump(byes, f, indent=2)

    print(f"Wrote {len(players)} players, {len(notes)} notes, {len(byes)} bye weeks "
          f"to {OUT_DIR}")


if __name__ == "__main__":
    main()
