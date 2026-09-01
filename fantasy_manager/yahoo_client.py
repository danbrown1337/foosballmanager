#!/usr/bin/env python3
"""
Yahoo Fantasy Sports API client — OAuth2 + read endpoints.

STATUS: written to Yahoo's documented spec but not yet exercised against a
real account, because Yahoo now gates Fantasy Sports API access behind an
application review (see sports.yahoo.com/developer/access/) and Dan's
Client ID/Secret don't exist until that's approved. Once they do:

  1. Put them in config/yahoo_credentials.json (see the template written
     by `python3 -m fantasy_manager.yahoo_client init`).
  2. Run `python3 -m fantasy_manager.yahoo_client authorize` once — it
     prints a Yahoo login/consent URL, you open it, approve, and paste
     the code it shows back into the prompt. Tokens get saved locally
     to yahoo_tokens.json and refreshed automatically after that.
  3. Run `python3 -m fantasy_manager.yahoo_client leagues` to sanity
     check the connection, then `sync-rosters --league-key <key>` to
     populate league_rosters.csv and my_roster.csv from live data.

IMPORTANT: Yahoo's Fantasy Sports API is read-only. There is no method
here (and none is coming) that submits trades, adds/drops players, or
otherwise writes to your league — that has to happen through the Yahoo
app/site itself. See trade_targeter.py for why that's actually the safer
way to run the lowball-offer plan anyway.
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import time
import urllib.parse
import urllib.request

from fantasy_manager.board import ROOT

CRED_PATH = os.path.join(ROOT, "config", "yahoo_credentials.json")
TOKEN_PATH = os.path.join(ROOT, "yahoo_tokens.json")

AUTH_URL = "https://api.login.yahoo.com/oauth2/request_auth"
TOKEN_URL = "https://api.login.yahoo.com/oauth2/get_token"
API_BASE = "https://fantasysports.yahooapis.com/fantasy/v2"

# "oob" (out-of-band) shows the code on Yahoo's confirmation page instead
# of redirecting anywhere — matches what we set as the app's redirect URI.
REDIRECT_URI = "oob"


def _load_json(path: str) -> dict | None:
    if not os.path.exists(path):
        return None
    with open(path) as f:
        return json.load(f)


def _save_json(path: str, data: dict) -> None:
    with open(path, "w") as f:
        json.dump(data, f, indent=2)


def cmd_init(args):
    if os.path.exists(CRED_PATH):
        print(f"{CRED_PATH} already exists — not overwriting.")
        return
    _save_json(CRED_PATH, {"client_id": "PASTE_CLIENT_ID_HERE", "client_secret": "PASTE_CLIENT_SECRET_HERE"})
    print(f"Wrote template to {CRED_PATH}. Fill in your Client ID/Secret once Yahoo approves access, "
          f"then run: python3 -m fantasy_manager.yahoo_client authorize")


def _creds() -> tuple[str, str]:
    creds = _load_json(CRED_PATH)
    if not creds or "PASTE_" in creds.get("client_id", ""):
        raise SystemExit(f"No Yahoo credentials yet. Run `init`, fill in {CRED_PATH}, then `authorize`.")
    return creds["client_id"], creds["client_secret"]


def cmd_authorize(args):
    client_id, client_secret = _creds()
    params = {
        "client_id": client_id,
        "redirect_uri": REDIRECT_URI,
        "response_type": "code",
        "language": "en-us",
    }
    url = f"{AUTH_URL}?{urllib.parse.urlencode(params)}"
    print("Open this URL, sign in, and approve access:\n")
    print(f"  {url}\n")
    code = input("Paste the code Yahoo shows you here: ").strip()

    data = urllib.parse.urlencode({
        "client_id": client_id,
        "client_secret": client_secret,
        "redirect_uri": REDIRECT_URI,
        "code": code,
        "grant_type": "authorization_code",
    }).encode()

    req = urllib.request.Request(TOKEN_URL, data=data, method="POST")
    req.add_header("Content-Type", "application/x-www-form-urlencoded")
    with urllib.request.urlopen(req) as resp:
        token = json.loads(resp.read())

    token["obtained_at"] = time.time()
    _save_json(TOKEN_PATH, token)
    print("Authorized. Tokens saved — you shouldn't need to run this again unless you revoke access.")


def _refresh(token: dict) -> dict:
    client_id, client_secret = _creds()
    data = urllib.parse.urlencode({
        "client_id": client_id,
        "client_secret": client_secret,
        "redirect_uri": REDIRECT_URI,
        "refresh_token": token["refresh_token"],
        "grant_type": "refresh_token",
    }).encode()
    req = urllib.request.Request(TOKEN_URL, data=data, method="POST")
    req.add_header("Content-Type", "application/x-www-form-urlencoded")
    with urllib.request.urlopen(req) as resp:
        new_token = json.loads(resp.read())
    new_token["obtained_at"] = time.time()
    new_token.setdefault("refresh_token", token["refresh_token"])
    _save_json(TOKEN_PATH, new_token)
    return new_token


def _access_token() -> str:
    token = _load_json(TOKEN_PATH)
    if not token:
        raise SystemExit("Not authorized yet. Run: python3 -m fantasy_manager.yahoo_client authorize")
    age = time.time() - token.get("obtained_at", 0)
    if age > token.get("expires_in", 3600) - 60:
        token = _refresh(token)
    return token["access_token"]


def api_get(path: str) -> dict:
    """GET a Fantasy Sports API path (no leading slash), e.g. 'users;use_login=1/games'."""
    url = f"{API_BASE}/{path}?format=json"
    req = urllib.request.Request(url)
    req.add_header("Authorization", f"Bearer {_access_token()}")
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read())


def cmd_leagues(args):
    """List the user's NFL fantasy leagues — sanity check that auth works."""
    result = api_get("users;use_login=1/games;game_keys=nfl/leagues")
    print(json.dumps(result, indent=2)[:4000])
    print("\n(Full response may be longer — look for league_key values like '449.l.123456'.)")


def cmd_sync_rosters(args):
    """
    Pull every team's roster in a league and write league_rosters.csv,
    plus my_roster.csv for the team matching --my-team-key (or the first
    team flagged is_owned_by_current_login if omitted).

    NOTE: exact JSON shape depends on Yahoo's nested collection format,
    which varies by endpoint version — if this errors, print the raw
    api_get() response and adjust the parsing below; the auth/refresh
    plumbing above is the part that matters and won't need to change.
    """
    league_key = args.league_key
    result = api_get(f"league/{league_key}/teams")
    rows = []
    my_rows = []

    try:
        teams_blob = result["fantasy_content"]["league"][1]["teams"]
    except (KeyError, IndexError, TypeError):
        print("Unexpected response shape — dumping raw JSON for manual inspection:")
        print(json.dumps(result, indent=2))
        return

    for key, team_wrap in teams_blob.items():
        if key == "count":
            continue
        team_meta = team_wrap["team"][0]
        team_key = next((f["team_key"] for f in team_meta if isinstance(f, dict) and "team_key" in f), None)
        team_name = next((f["name"] for f in team_meta if isinstance(f, dict) and "name" in f), team_key)
        is_mine = any(isinstance(f, dict) and f.get("is_owned_by_current_login") == 1 for f in team_meta)

        roster = api_get(f"team/{team_key}/roster")
        try:
            players_blob = roster["fantasy_content"]["team"][1]["roster"]["0"]["players"]
        except (KeyError, IndexError, TypeError):
            continue

        for pkey, p_wrap in players_blob.items():
            if pkey == "count":
                continue
            p_meta = p_wrap["player"][0]
            name = next((f["name"]["full"] for f in p_meta if isinstance(f, dict) and "name" in f), None)
            pos = next((f["display_position"] for f in p_meta if isinstance(f, dict) and "display_position" in f), None)
            team_abbr = next((f["editorial_team_abbr"] for f in p_meta if isinstance(f, dict) and "editorial_team_abbr" in f), None)
            if not name:
                continue
            rows.append({"team_name": team_name, "manager": "", "name": name, "pos": pos, "team": team_abbr})
            if is_mine:
                my_rows.append({"name": name, "pos": pos, "team": team_abbr})

    with open(os.path.join(ROOT, "league_rosters.csv"), "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["team_name", "manager", "name", "pos", "team"])
        w.writeheader()
        w.writerows(rows)

    if my_rows:
        with open(os.path.join(ROOT, "my_roster.csv"), "w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=["name", "pos", "team"])
            w.writeheader()
            w.writerows(my_rows)

    print(f"Synced {len(rows)} players across the league. Wrote league_rosters.csv"
          + (" and my_roster.csv." if my_rows else " (couldn't identify your team — check my_roster.csv manually)."))


def main():
    parser = argparse.ArgumentParser(description="Yahoo Fantasy Sports API client")
    sub = parser.add_subparsers(dest="cmd", required=True)

    sub.add_parser("init", help="Write a credentials template").set_defaults(func=cmd_init)
    sub.add_parser("authorize", help="Run the OAuth2 login flow once").set_defaults(func=cmd_authorize)
    sub.add_parser("leagues", help="List your NFL leagues (auth check)").set_defaults(func=cmd_leagues)

    p_sync = sub.add_parser("sync-rosters", help="Pull league rosters into the CSVs")
    p_sync.add_argument("--league-key", required=True, help="e.g. 449.l.123456 (from `leagues`)")
    p_sync.set_defaults(func=cmd_sync_rosters)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
