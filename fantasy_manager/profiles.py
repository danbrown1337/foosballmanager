#!/usr/bin/env python3
"""
Per-person setup, so two people can use one checkout without collision.

Everything that is *yours* — league settings, rosters, live draft state,
Yahoo credentials — lives under profiles/<name>/. Everything that is
league-agnostic — the ADP board and the researched player notes — stays
shared in data/, because those are general 2026 rankings, not anybody's
league.

    profiles/
      dan/    league.yaml  my_roster.csv  league_rosters.csv  draft_state.json
      alex/   league.yaml  my_roster.csv  league_rosters.csv  draft_state.json

Selected with --profile on any command, or the FANTASY_PROFILE environment
variable. Unset means the "default" profile, so a single user never has to
think about this at all.

config/league.yaml is the template new profiles are seeded from — edit a
profile's own copy, not the template.
"""
from __future__ import annotations

import os
import shutil

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROFILES_DIR = os.path.join(ROOT, "profiles")
TEMPLATE_CONFIG = os.path.join(ROOT, "config", "league.yaml")

# Shared across profiles: general NFL rankings, not league-specific.
DATA_DIR = os.path.join(ROOT, "data")
DEFAULT_ADP = os.path.join(DATA_DIR, "adp_2026_ppr.csv")
DEFAULT_NOTES = os.path.join(DATA_DIR, "player_notes_2026.csv")

DEFAULT_PROFILE = "default"
ENV_VAR = "FANTASY_PROFILE"

# Files seeded into a new profile, and the header each empty CSV starts with.
CSV_TEMPLATES = {
    "my_roster.csv": "name,pos,team\n",
    "league_rosters.csv": "team_name,manager,name,pos,team\n",
}


def active_profile() -> str:
    """Whichever profile the current command is operating on."""
    return os.environ.get(ENV_VAR) or DEFAULT_PROFILE


def set_active_profile(name: str | None) -> str:
    """Called once from each CLI's main() so everything downstream resolves
    to the same person's files without threading a parameter through."""
    if name:
        os.environ[ENV_VAR] = name
    return active_profile()


def profile_dir(name: str | None = None) -> str:
    return os.path.join(PROFILES_DIR, name or active_profile())


def config_path(name: str | None = None) -> str:
    return os.path.join(profile_dir(name), "league.yaml")


def my_roster_path(name: str | None = None) -> str:
    return os.path.join(profile_dir(name), "my_roster.csv")


def league_rosters_path(name: str | None = None) -> str:
    return os.path.join(profile_dir(name), "league_rosters.csv")


def draft_state_path(name: str | None = None) -> str:
    return os.path.join(profile_dir(name), "draft_state.json")


def credentials_path(name: str | None = None) -> str:
    return os.path.join(profile_dir(name), "yahoo_credentials.json")


def tokens_path(name: str | None = None) -> str:
    return os.path.join(profile_dir(name), "yahoo_tokens.json")


def exists(name: str | None = None) -> bool:
    return os.path.isfile(config_path(name))


def list_profiles() -> list[str]:
    if not os.path.isdir(PROFILES_DIR):
        return []
    return sorted(
        entry for entry in os.listdir(PROFILES_DIR)
        if os.path.isfile(os.path.join(PROFILES_DIR, entry, "league.yaml"))
    )


def ensure_profile(name: str | None = None) -> str:
    """Create the profile if it isn't there yet, seeded from the template.

    Called lazily on first use so nobody has to run a setup step before the
    tool works — a fresh clone just runs.
    """
    name = name or active_profile()
    directory = profile_dir(name)
    os.makedirs(directory, exist_ok=True)

    config = config_path(name)
    if not os.path.exists(config):
        shutil.copyfile(TEMPLATE_CONFIG, config)

    for filename, header in CSV_TEMPLATES.items():
        path = os.path.join(directory, filename)
        if not os.path.exists(path):
            with open(path, "w", newline="") as f:
                f.write(header)

    _migrate_legacy_files(directory)
    return directory


def _migrate_legacy_files(directory: str) -> list[str]:
    """Earlier versions kept these in the repo root. If a real one is still
    sitting there, move its contents in rather than silently ignoring it —
    losing a hand-filled roster to a refactor would be unforgivable.

    Only non-empty files are migrated; a bare header carries nothing.
    """
    moved = []
    for filename in (*CSV_TEMPLATES, "draft_state.json"):
        legacy = os.path.join(ROOT, filename)
        if not os.path.isfile(legacy):
            continue
        content = open(legacy).read()
        header = CSV_TEMPLATES.get(filename)
        if not content.strip() or (header and content.strip() == header.strip()):
            continue  # nothing but a header
        target = os.path.join(directory, filename)
        if os.path.exists(target) and open(target).read().strip() not in ("", (header or "").strip()):
            continue  # profile already has real content; don't clobber it
        with open(target, "w", newline="") as f:
            f.write(content)
        moved.append(filename)
    return moved


def main():
    import argparse

    parser = argparse.ArgumentParser(description="Manage per-person setups")
    sub = parser.add_subparsers(dest="cmd", required=True)

    sub.add_parser("list", help="Show the profiles that exist")

    p_new = sub.add_parser("new", help="Create a profile, seeded from the template")
    p_new.add_argument("name")

    p_where = sub.add_parser("where", help="Print where a profile's files live")
    p_where.add_argument("name", nargs="?", default=None)

    args = parser.parse_args()

    if args.cmd == "list":
        existing = list_profiles()
        if not existing:
            print("No profiles yet. One is created automatically the first time "
                  "you run anything, or make one now:\n"
                  "  python3 -m fantasy_manager.profiles new alex")
            return
        current = active_profile()
        for name in existing:
            print(f"{'*' if name == current else ' '} {name}  ({profile_dir(name)})")
        return

    if args.cmd == "new":
        already = exists(args.name)
        directory = ensure_profile(args.name)
        verb = "Already set up" if already else "Created"
        print(f"{verb}: {directory}")
        if not already:
            print(f"\nNext: edit {config_path(args.name)} to match the league —\n"
                  f"team count, scoring and roster slots. Then run anything with\n"
                  f"  --profile {args.name}")
        return

    print(profile_dir(args.name))


if __name__ == "__main__":
    main()
