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
     prints a Yahoo login/consent URL, you open it and approve. Yahoo
     redirects to the app's registered HTTPS redirect URI, which shows an
     error page because nothing is listening there; paste that whole URL
     back into the prompt and the code is pulled out of its query string.
     Tokens get saved locally to yahoo_tokens.json (mode 0600) and
     refreshed automatically after that.
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
import urllib.error
import urllib.parse
import urllib.request

from fantasy_manager.board import ROOT

CRED_PATH = os.path.join(ROOT, "config", "yahoo_credentials.json")
TOKEN_PATH = os.path.join(ROOT, "yahoo_tokens.json")

AUTH_URL = "https://api.login.yahoo.com/oauth2/request_auth"
TOKEN_URL = "https://api.login.yahoo.com/oauth2/get_token"
API_BASE = "https://fantasysports.yahooapis.com/fantasy/v2"

# Yahoo requires the redirect_uri sent here to match the one registered on
# the app exactly. Yahoo now wants an HTTPS redirect for new apps, and the
# older "oob" (out-of-band, code shown on screen) flow is not reliably
# accepted any more — so this is configurable rather than hardcoded, and
# lives in config/yahoo_credentials.json next to the client ID/secret.
#
# With an HTTPS redirect there's no server here to receive the callback:
# the browser just lands on a dead localhost page, and the code sits in
# its URL bar. `authorize` accepts that whole URL pasted in, so no local
# callback server (and no self-signed certificate) is needed.
DEFAULT_REDIRECT_URI = "https://localhost:8000"


def _load_json(path: str) -> dict | None:
    if not os.path.exists(path):
        return None
    with open(path) as f:
        return json.load(f)


def _save_json(path: str, data: dict) -> None:
    """Written 0600 — these files hold the client secret and the OAuth
    refresh token, which is a long-lived credential to the Yahoo account."""
    with open(path, "w") as f:
        json.dump(data, f, indent=2)
    os.chmod(path, 0o600)


def _http_error_detail(err: "urllib.error.HTTPError") -> str:
    """Yahoo puts the useful part in the body, not the status line."""
    try:
        return err.read().decode("utf-8", "replace")[:500]
    except Exception:
        return ""


def _post_for_token(req) -> dict:
    try:
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as err:
        detail = _http_error_detail(err)
        hint = ""
        if err.code in (400, 401):
            hint = (
                "\n\nUsual causes:\n"
                f"  - redirect_uri in {CRED_PATH} doesn't exactly match the one\n"
                "    registered on your Yahoo app (this is the most common one)\n"
                "  - the authorization code was already used, or has expired\n"
                "    (they're single-use and short-lived — rerun `authorize`)\n"
                "  - Client ID/Secret are wrong, or Fantasy API access isn't\n"
                "    approved for this app yet"
            )
        raise SystemExit(f"Yahoo rejected the token request (HTTP {err.code}). {detail}{hint}")


def cmd_init(args):
    if os.path.exists(CRED_PATH):
        print(f"{CRED_PATH} already exists — not overwriting.")
        return
    _save_json(CRED_PATH, {
        "client_id": "PASTE_CLIENT_ID_HERE",
        "client_secret": "PASTE_CLIENT_SECRET_HERE",
        # Must match the Redirect URI registered on the Yahoo app exactly.
        "redirect_uri": DEFAULT_REDIRECT_URI,
    })
    print(f"Wrote template to {CRED_PATH}. Fill in your Client ID/Secret once Yahoo approves access, "
          f"then run: python3 -m fantasy_manager.yahoo_client authorize")
    print(f"Set redirect_uri to whatever you registered on the Yahoo app "
          f"(default {DEFAULT_REDIRECT_URI}).")


def _creds() -> tuple[str, str, str]:
    creds = _load_json(CRED_PATH)
    if not creds or "PASTE_" in creds.get("client_id", ""):
        raise SystemExit(f"No Yahoo credentials yet. Run `init`, fill in {CRED_PATH}, then `authorize`.")
    return (
        creds["client_id"],
        creds["client_secret"],
        creds.get("redirect_uri", DEFAULT_REDIRECT_URI),
    )


def extract_code(pasted: str) -> str:
    """Accept either the bare authorization code or the whole URL the browser
    landed on. With an HTTPS redirect there is no server listening, so the
    browser shows an error page and the code is only visible in the URL bar —
    pasting that URL is the path of least resistance, and far less error-prone
    than picking the code out of it by hand."""
    pasted = pasted.strip()
    if "?" not in pasted and "&" not in pasted:
        return pasted
    query = urllib.parse.urlparse(pasted).query or pasted.split("?", 1)[-1]
    params = urllib.parse.parse_qs(query)
    if "error" in params:
        raise SystemExit(
            f"Yahoo returned an error instead of a code: {params['error'][0]}"
            + (f" — {params['error_description'][0]}" if "error_description" in params else "")
        )
    if "code" not in params:
        raise SystemExit(f"Couldn't find a code in what you pasted: {pasted[:120]}")
    return params["code"][0]


def cmd_authorize(args):
    client_id, client_secret, redirect_uri = _creds()
    params = {
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "language": "en-us",
    }
    url = f"{AUTH_URL}?{urllib.parse.urlencode(params)}"
    print("Open this URL, sign in, and approve access:\n")
    print(f"  {url}\n")
    if redirect_uri != "oob":
        print(f"Your browser will then be redirected to {redirect_uri} and show an")
        print("error page — that's expected, nothing is listening there. Copy the")
        print("whole URL out of the address bar and paste it below.\n")
    code = extract_code(input("Paste the code (or the full redirect URL) here: "))

    data = urllib.parse.urlencode({
        "client_id": client_id,
        "client_secret": client_secret,
        "redirect_uri": redirect_uri,
        "code": code,
        "grant_type": "authorization_code",
    }).encode()

    req = urllib.request.Request(TOKEN_URL, data=data, method="POST")
    req.add_header("Content-Type", "application/x-www-form-urlencoded")
    token = _post_for_token(req)

    token["obtained_at"] = time.time()
    _save_json(TOKEN_PATH, token)
    print("Authorized. Tokens saved — you shouldn't need to run this again unless you revoke access.")


def _refresh(token: dict) -> dict:
    client_id, client_secret, redirect_uri = _creds()
    data = urllib.parse.urlencode({
        "client_id": client_id,
        "client_secret": client_secret,
        "redirect_uri": redirect_uri,
        "refresh_token": token["refresh_token"],
        "grant_type": "refresh_token",
    }).encode()
    req = urllib.request.Request(TOKEN_URL, data=data, method="POST")
    req.add_header("Content-Type", "application/x-www-form-urlencoded")
    new_token = _post_for_token(req)
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
    try:
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as err:
        detail = _http_error_detail(err)
        if err.code == 401:
            raise SystemExit(
                "Yahoo rejected the access token (HTTP 401). Try rerunning "
                "`authorize` — if that doesn't help, the app's Fantasy API "
                f"access may not be approved.\n{detail}"
            )
        if err.code == 403:
            raise SystemExit(
                "Yahoo returned HTTP 403 for this request. That usually means "
                "Fantasy Sports API access hasn't been granted for this app "
                f"yet, or the league isn't visible to this account.\n{detail}"
            )
        raise SystemExit(f"Yahoo API request failed (HTTP {err.code}) for {path}.\n{detail}")


def cmd_leagues(args):
    """List the user's NFL fantasy leagues — sanity check that auth works."""
    result = api_get("users;use_login=1/games;game_keys=nfl/leagues")
    print(json.dumps(result, indent=2)[:4000])
    print("\n(Full response may be longer — look for league_key values like '449.l.123456'.)")


def _first_field(meta, key):
    """Yahoo team/player metadata arrives as a list mixing dicts and nested
    lists; the field you want is in one of the dicts."""
    return next((f[key] for f in meta if isinstance(f, dict) and key in f), None)


def extract_position(p_meta) -> str | None:
    """Yahoo's display_position is comma-separated for multi-eligible players
    ("WR,TE"), which no downstream position filter would ever match — it would
    silently vanish from roster summaries and trade offers. primary_position
    is the single canonical one; fall back to the first of display_position."""
    primary = _first_field(p_meta, "primary_position")
    if primary:
        return primary.strip()
    display = _first_field(p_meta, "display_position")
    if display:
        return display.split(",")[0].strip()
    return None


def extract_manager(team_meta) -> str:
    """Manager nickname, for league_rosters.csv and the rivals: config."""
    managers = _first_field(team_meta, "managers")
    if not managers:
        return ""
    names = []
    for entry in managers:
        manager = entry.get("manager") if isinstance(entry, dict) else None
        if isinstance(manager, dict) and manager.get("nickname"):
            names.append(manager["nickname"])
    return ", ".join(names)


def parse_team_roster(roster_json) -> list[dict]:
    """Pull (name, pos, team) rows out of a /team/{key}/roster response."""
    try:
        players_blob = roster_json["fantasy_content"]["team"][1]["roster"]["0"]["players"]
    except (KeyError, IndexError, TypeError):
        return []

    rows = []
    for pkey, p_wrap in players_blob.items():
        if pkey == "count":
            continue
        p_meta = p_wrap["player"][0]
        name = _first_field(p_meta, "name")
        name = name.get("full") if isinstance(name, dict) else name
        if not name:
            continue
        rows.append({
            "name": name,
            "pos": extract_position(p_meta),
            "team": _first_field(p_meta, "editorial_team_abbr"),
        })
    return rows


def cmd_sync_rosters(args):
    """
    Pull every team's roster in a league and write league_rosters.csv, plus
    my_roster.csv for the team matching --my-team-key (or the team flagged
    is_owned_by_current_login if omitted).

    NOTE: the exact JSON shape depends on Yahoo's nested collection format,
    which varies by endpoint version. If parsing comes up empty this prints
    the raw response so the shape can be inspected; the auth/refresh plumbing
    above is the part that matters and won't need to change.
    """
    result = api_get(f"league/{args.league_key}/teams")
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
        team_key = _first_field(team_meta, "team_key")
        team_name = _first_field(team_meta, "name") or team_key
        manager = extract_manager(team_meta)

        if args.my_team_key:
            is_mine = team_key == args.my_team_key
        else:
            is_mine = any(
                isinstance(f, dict) and f.get("is_owned_by_current_login") == 1
                for f in team_meta
            )

        for player in parse_team_roster(api_get(f"team/{team_key}/roster")):
            rows.append({"team_name": team_name, "manager": manager, **player})
            if is_mine:
                my_rows.append(player)

    if not rows:
        print("No players parsed. Check the league key, or run `leagues` to list yours.")
        return

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
          + (" and my_roster.csv." if my_rows else
             " (couldn't identify your team — pass --my-team-key, or fill in my_roster.csv manually)."))
    report_unmatched(rows)


def report_unmatched(rows) -> list[str]:
    """Yahoo's player names don't always match the ADP board's — defenses in
    particular. Anything unmatched is invisible to the trade generator and the
    waiver view, which priced players by ADP, so say so loudly rather than
    letting those players quietly count for nothing.
    """
    from fantasy_manager.board import load_players

    board = {p.name for p in load_players()}
    unmatched = sorted({r["name"] for r in rows if r["name"] not in board})
    if unmatched:
        print(f"\n{len(unmatched)} synced player(s) don't match a name on the ADP board, "
              f"so they have no value attached:")
        for name in unmatched[:20]:
            print(f"  {name}")
        if len(unmatched) > 20:
            print(f"  ... and {len(unmatched) - 20} more")
        print("Deep bench players are expected here; a starter showing up means "
              "the name spelling differs and is worth aliasing.")
    return unmatched


def main():
    parser = argparse.ArgumentParser(description="Yahoo Fantasy Sports API client")
    sub = parser.add_subparsers(dest="cmd", required=True)

    sub.add_parser("init", help="Write a credentials template").set_defaults(func=cmd_init)
    sub.add_parser("authorize", help="Run the OAuth2 login flow once").set_defaults(func=cmd_authorize)
    sub.add_parser("leagues", help="List your NFL leagues (auth check)").set_defaults(func=cmd_leagues)

    p_sync = sub.add_parser("sync-rosters", help="Pull league rosters into the CSVs")
    p_sync.add_argument("--league-key", required=True, help="e.g. 449.l.123456 (from `leagues`)")
    p_sync.add_argument("--my-team-key", default=None,
                        help="e.g. 449.l.123456.t.4 — only needed if your team isn't auto-detected")
    p_sync.set_defaults(func=cmd_sync_rosters)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
