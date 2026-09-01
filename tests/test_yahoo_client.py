"""Tests for the Yahoo client's parsing and OAuth plumbing.

The network calls themselves aren't exercised — Yahoo gates API access behind
an approved application. What is exercised is everything that would otherwise
only be discovered live: the nested-collection parsing, the multi-position
handling, the authorization-code extraction, and the file permissions on
credentials.

Response shapes below mirror Yahoo's documented Fantasy Sports API JSON:
collections are dicts keyed by index with a "count", and team/player metadata
arrives as a list mixing dicts and nested lists.
"""
import json
import os
import stat

import pytest

from fantasy_manager.yahoo_client import (
    DEFAULT_REDIRECT_URI,
    _save_json,
    extract_code,
    extract_manager,
    extract_position,
    parse_team_roster,
    report_unmatched,
)


def player(name, *, primary=None, display=None, team="DET"):
    meta = [{"player_key": "449.p.1"}, {"name": {"full": name, "first": name.split()[0]}}]
    if team:
        meta.append({"editorial_team_abbr": team})
    if display:
        meta.append({"display_position": display})
    if primary:
        meta.append({"primary_position": primary})
    return meta


def roster_response(*player_metas):
    players = {str(i): {"player": [meta]} for i, meta in enumerate(player_metas)}
    players["count"] = len(player_metas)
    return {"fantasy_content": {"team": [
        [{"team_key": "449.l.1.t.1"}],
        {"roster": {"0": {"players": players}, "coverage_type": "week"}},
    ]}}


class TestExtractPosition:
    def test_prefers_primary_position(self):
        assert extract_position(player("A", primary="WR", display="WR,TE")) == "WR"

    def test_multi_eligible_display_collapses_to_the_first(self):
        """"WR,TE" would match no position filter anywhere downstream — the
        player would silently vanish from roster summaries and trade offers."""
        assert extract_position(player("A", display="WR,TE")) == "WR"

    def test_single_display_position(self):
        assert extract_position(player("A", display="RB")) == "RB"

    def test_whitespace_is_stripped(self):
        assert extract_position(player("A", display="RB, WR")) == "RB"

    def test_missing_position_is_none_not_a_crash(self):
        assert extract_position(player("A")) is None

    def test_defense_and_kicker_pass_through_for_alias_normalization(self):
        # POS_ALIASES maps DEF/K variants downstream; this just must not mangle.
        assert extract_position(player("A", primary="DEF")) == "DEF"
        assert extract_position(player("A", primary="K")) == "K"


class TestExtractManager:
    def test_single_manager(self):
        meta = [{"name": "Team"}, {"managers": [{"manager": {"nickname": "Dan"}}]}]
        assert extract_manager(meta) == "Dan"

    def test_co_managers_are_joined(self):
        meta = [{"managers": [
            {"manager": {"nickname": "Dan"}},
            {"manager": {"nickname": "Sam"}},
        ]}]
        assert extract_manager(meta) == "Dan, Sam"

    def test_missing_managers_is_blank(self):
        assert extract_manager([{"name": "Team"}]) == ""

    def test_manager_without_a_nickname_is_skipped(self):
        meta = [{"managers": [{"manager": {"manager_id": "1"}}]}]
        assert extract_manager(meta) == ""


class TestParseTeamRoster:
    def test_parses_a_realistic_response(self):
        rows = parse_team_roster(roster_response(
            player("Jahmyr Gibbs", primary="RB", team="DET"),
            player("Puka Nacua", primary="WR", team="LAR"),
        ))
        assert rows == [
            {"name": "Jahmyr Gibbs", "pos": "RB", "team": "DET"},
            {"name": "Puka Nacua", "pos": "WR", "team": "LAR"},
        ]

    def test_count_key_is_not_treated_as_a_player(self):
        rows = parse_team_roster(roster_response(player("Solo Guy", primary="TE")))
        assert len(rows) == 1

    def test_multi_position_player_gets_a_usable_position(self):
        rows = parse_team_roster(roster_response(player("Flex Guy", display="RB,WR")))
        assert rows[0]["pos"] == "RB"

    def test_unexpected_shape_returns_empty_rather_than_raising(self):
        assert parse_team_roster({"fantasy_content": {}}) == []
        assert parse_team_roster({}) == []

    def test_player_without_a_name_is_skipped(self):
        blob = roster_response(player("Real Guy", primary="RB"))
        blob["fantasy_content"]["team"][1]["roster"]["0"]["players"]["1"] = {
            "player": [[{"player_key": "449.p.2"}, {"editorial_team_abbr": "SF"}]]
        }
        rows = parse_team_roster(blob)
        assert [r["name"] for r in rows] == ["Real Guy"]

    def test_empty_roster(self):
        assert parse_team_roster(roster_response()) == []


class TestExtractCode:
    def test_bare_code_passes_through(self):
        assert extract_code("abc123def") == "abc123def"

    def test_whitespace_is_trimmed(self):
        assert extract_code("  abc123def \n") == "abc123def"

    def test_full_redirect_url_yields_the_code(self):
        """With an HTTPS redirect there's no server listening, so the code is
        only visible in the browser's address bar."""
        assert extract_code("https://localhost:8000/?code=xyz789&state=") == "xyz789"

    def test_url_without_a_scheme(self):
        assert extract_code("localhost:8000/?code=xyz789") == "xyz789"

    def test_yahoo_error_is_surfaced_not_swallowed(self):
        with pytest.raises(SystemExit) as excinfo:
            extract_code("https://localhost:8000/?error=access_denied"
                         "&error_description=User+denied")
        assert "access_denied" in str(excinfo.value)

    def test_url_with_no_code_is_an_error(self):
        with pytest.raises(SystemExit):
            extract_code("https://localhost:8000/?state=nothing")


class TestCredentialFilePermissions:
    def test_secrets_are_written_owner_only(self, tmp_path):
        """These files hold the client secret and a long-lived refresh token."""
        path = str(tmp_path / "tokens.json")
        _save_json(path, {"refresh_token": "secret"})
        mode = stat.S_IMODE(os.stat(path).st_mode)
        assert mode == 0o600, f"expected 0600, got {oct(mode)}"

    def test_content_still_round_trips(self, tmp_path):
        path = str(tmp_path / "creds.json")
        _save_json(path, {"client_id": "abc"})
        assert json.loads(open(path).read()) == {"client_id": "abc"}


class TestDefaults:
    def test_default_redirect_is_https_not_oob(self):
        """Yahoo requires an HTTPS redirect URI for new apps; 'oob' is not
        reliably accepted any more."""
        assert DEFAULT_REDIRECT_URI.startswith("https://")


class TestReportUnmatched:
    def test_board_names_are_not_reported(self, capsys):
        assert report_unmatched([{"name": "Jahmyr Gibbs"}]) == []
        assert capsys.readouterr().out == ""

    def test_unknown_names_are_reported(self, capsys):
        unmatched = report_unmatched([
            {"name": "Jahmyr Gibbs"},
            {"name": "Some Practice Squad Guy"},
        ])
        assert unmatched == ["Some Practice Squad Guy"]
        assert "Some Practice Squad Guy" in capsys.readouterr().out
