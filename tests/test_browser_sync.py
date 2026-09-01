"""Tests for the browser-based roster import.

The parsing tests are the important ones and always run: they pin the
"Name TEAM - POS" extraction that everything downstream depends on, including
the exact-name matching that attaches a player's ADP value.

The Chrome-attach test is an integration test — it launches the bundled
Chromium with a debugging port and points the real CDP code at a local page,
which exercises fetch_page_text end to end without touching Yahoo. It skips
when Playwright isn't installed.
"""
import shutil
import socket
import subprocess
import time

import pytest

from fantasy_manager.board import load_players
from fantasy_manager.browser_sync import (
    diff_drafted,
    find_board_names,
    looks_like_a_player,
    normalize_position,
    parse_league_page,
    parse_roster_text,
)


class TestNormalizePosition:
    def test_plain_position(self):
        assert normalize_position("RB") == "RB"

    def test_multi_eligible_keeps_the_first(self):
        assert normalize_position("TE,QB") == "TE"

    def test_whitespace_and_case(self):
        assert normalize_position(" rb , wr ") == "RB"

    def test_source_aliases_are_normalized(self):
        assert normalize_position("PK") == "K"
        assert normalize_position("DST") == "DEF"


class TestLooksLikeAPlayer:
    @pytest.mark.parametrize("name", ["Josh Allen", "A.J. Brown", "Amon-Ra St. Brown"])
    def test_real_names(self, name):
        assert looks_like_a_player(name)

    @pytest.mark.parametrize("name", ["QB", "BN", "W/R/T", "", "  ", "12.5", "Week 3"])
    def test_chrome_and_stats_are_rejected(self, name):
        assert not looks_like_a_player(name)


class TestParseRosterText:
    SAMPLE = """
    QB Josh Allen Buf - QB
    BN Jahmyr Gibbs Det - RB
    WR Ja'Marr Chase Cin - WR Q
    Taysom Hill NO - TE,QB
    Seattle Seahawks Sea - DEF
    Brandon Aubrey Dal - K
    Total Points 1234.5
    """

    def test_extracts_every_player(self):
        assert len(parse_roster_text(self.SAMPLE)) == 6

    def test_team_is_uppercased_to_match_the_board(self):
        rows = {r["name"]: r for r in parse_roster_text(self.SAMPLE)}
        assert rows["Josh Allen"]["team"] == "BUF"
        assert rows["Jahmyr Gibbs"]["team"] == "DET"

    def test_roster_slot_label_is_not_folded_into_the_name(self):
        """"BN Jahmyr Gibbs" would never match the ADP board."""
        names = [r["name"] for r in parse_roster_text(self.SAMPLE)]
        assert "Jahmyr Gibbs" in names

    def test_injury_designation_does_not_corrupt_the_position(self):
        rows = {r["name"]: r for r in parse_roster_text(self.SAMPLE)}
        assert rows["Ja'Marr Chase"]["pos"] == "WR"

    def test_multi_eligible_collapses_to_one_position(self):
        rows = {r["name"]: r for r in parse_roster_text(self.SAMPLE)}
        assert rows["Taysom Hill"]["pos"] == "TE"

    def test_stat_rows_are_ignored(self):
        assert "Total Points" not in [r["name"] for r in parse_roster_text(self.SAMPLE)]

    def test_duplicates_are_collapsed(self):
        text = "Josh Allen Buf - QB\nJosh Allen Buf - QB"
        assert len(parse_roster_text(text)) == 1

    def test_empty_input(self):
        assert parse_roster_text("") == []

    def test_unrelated_text_yields_nothing(self):
        assert parse_roster_text("Just some prose - with a dash in it.") == []


class TestNamesMatchTheAdpBoard:
    """The whole point of exact extraction: an unmatched name carries no ADP,
    so the player is invisible to the trade generator and the waiver view."""

    @pytest.mark.parametrize("line,expected", [
        ("Marvin Harrison Jr. Ari - WR", "Marvin Harrison Jr."),
        ("A.J. Brown Phi - WR", "A.J. Brown"),
        ("Amon-Ra St. Brown Det - WR", "Amon-Ra St. Brown"),
        ("Travis Etienne Jr. Jax - RB", "Travis Etienne Jr."),
        ("Ja'Marr Chase Cin - WR", "Ja'Marr Chase"),
    ])
    def test_punctuation_in_names_survives(self, line, expected):
        rows = parse_roster_text(line)
        assert rows and rows[0]["name"] == expected

    def test_extracted_names_are_found_on_the_real_board(self):
        board = {p.name for p in load_players()}
        text = "\n".join([
            "Marvin Harrison Jr. Ari - WR",
            "A.J. Brown Phi - WR",
            "Amon-Ra St. Brown Det - WR",
            "Jahmyr Gibbs Det - RB",
        ])
        for row in parse_roster_text(text):
            assert row["name"] in board, f"{row['name']} would carry no ADP value"


class TestParseLeaguePage:
    PAGE = """
    Team Alpha
    Josh Allen Buf - QB
    Jahmyr Gibbs Det - RB
    Team Bravo
    Puka Nacua LAR - WR
    """

    def test_groups_players_under_their_team(self):
        teams = parse_league_page(self.PAGE)
        assert set(teams) == {"Team Alpha", "Team Bravo"}
        assert len(teams["Team Alpha"]) == 2
        assert len(teams["Team Bravo"]) == 1

    def test_page_without_headings_still_yields_players(self):
        teams = parse_league_page("Josh Allen Buf - QB")
        assert sum(len(v) for v in teams.values()) == 1


class TestFindBoardNames:
    """Draft watching searches for the ~190 names already on the ADP board
    rather than parsing the draft room's structure — no selectors, survives any
    layout, and it cannot invent a player who doesn't exist."""

    BOARD = {"Jahmyr Gibbs", "Josh Allen", "Marvin Harrison Jr.",
             "A.J. Brown", "Amon-Ra St. Brown", "Puka Nacua"}

    def test_finds_names_in_a_pick_feed(self):
        page = "1.01 Jahmyr Gibbs Det - RB\n1.02 Puka Nacua LAR - WR"
        assert find_board_names(page, self.BOARD) == {"Jahmyr Gibbs", "Puka Nacua"}

    def test_names_with_punctuation_are_found(self):
        page = "Marvin Harrison Jr. Ari - WR and A.J. Brown Phi - WR"
        found = find_board_names(page, self.BOARD)
        assert "Marvin Harrison Jr." in found
        assert "A.J. Brown" in found

    def test_does_not_match_inside_a_longer_name(self):
        """"Josh Allenson" must not register as "Josh Allen" being drafted."""
        assert find_board_names("Josh Allenson went undrafted", self.BOARD) == set()

    def test_empty_page_finds_nothing(self):
        assert find_board_names("", self.BOARD) == set()

    def test_unknown_players_are_never_invented(self):
        assert find_board_names("Some Guy Nobody Drafted", self.BOARD) == set()

    def test_is_order_independent(self):
        page = "Puka Nacua ... Jahmyr Gibbs"
        assert find_board_names(page, self.BOARD) == {"Puka Nacua", "Jahmyr Gibbs"}


class TestDiffDrafted:
    def test_appear_mode_reports_new_names(self):
        """A picks feed or results page: names show up as they're taken."""
        assert diff_drafted({"A"}, {"A", "B"}, "appear") == {"B"}

    def test_disappear_mode_reports_removed_names(self):
        """An available-player pool: names leave it as they're taken."""
        assert diff_drafted({"A", "B"}, {"A"}, "disappear") == {"B"}

    def test_no_change_yields_nothing(self):
        assert diff_drafted({"A"}, {"A"}, "appear") == set()
        assert diff_drafted({"A"}, {"A"}, "disappear") == set()

    def test_appear_ignores_names_that_left(self):
        assert diff_drafted({"A", "B"}, {"A"}, "appear") == set()

    def test_unknown_mode_defaults_to_appear(self):
        assert diff_drafted({"A"}, {"A", "B"}, "whatever") == {"B"}


CHROME = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome"


def _free_port():
    with socket.socket() as s:
        s.bind(("", 0))
        return s.getsockname()[1]


@pytest.mark.skipif(
    not shutil.which("python3") or not shutil.os.path.exists(CHROME),
    reason="bundled Chromium not present",
)
class TestChromeAttach:
    """Exercises the real connect_over_cdp path against a local page."""

    def test_reads_a_page_from_an_attached_browser(self, tmp_path):
        pytest.importorskip("playwright")
        from fantasy_manager.browser_sync import fetch_page_text

        fixture = tmp_path / "roster.html"
        fixture.write_text(
            "<html><body><table>"
            "<tr><td>QB Josh Allen Buf - QB</td></tr>"
            "<tr><td>BN Jahmyr Gibbs Det - RB</td></tr>"
            "</table></body></html>"
        )
        port = _free_port()
        proc = subprocess.Popen(
            [CHROME, "--headless=new", f"--remote-debugging-port={port}",
             "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "about:blank"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        try:
            deadline = time.time() + 30
            while time.time() < deadline:
                try:
                    with socket.create_connection(("localhost", port), timeout=1):
                        break
                except OSError:
                    time.sleep(0.3)
            else:
                pytest.skip("Chromium did not open its debugging port")

            text, html = fetch_page_text(f"file://{fixture}", port)
            assert "Josh Allen" in text
            assert "<table" in html
            rows = {r["name"]: r for r in parse_roster_text(text)}
            assert rows["Josh Allen"]["pos"] == "QB"
            assert rows["Jahmyr Gibbs"]["team"] == "DET"
        finally:
            proc.terminate()
            proc.wait(timeout=10)

    def test_session_reuse_picks_up_page_changes(self, tmp_path):
        """What the watch loop depends on: one attached browser, re-read across
        polls, seeing content that changed between them."""
        pytest.importorskip("playwright")
        from fantasy_manager.browser_sync import BrowserSession, find_board_names

        fixture = tmp_path / "draft.html"
        fixture.write_text("<html><body><div>Jahmyr Gibbs Det - RB</div></body></html>")
        board = {"Jahmyr Gibbs", "Puka Nacua"}

        port = _free_port()
        proc = subprocess.Popen(
            [CHROME, "--headless=new", f"--remote-debugging-port={port}",
             "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "about:blank"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        try:
            deadline = time.time() + 30
            while time.time() < deadline:
                try:
                    with socket.create_connection(("localhost", port), timeout=1):
                        break
                except OSError:
                    time.sleep(0.3)
            else:
                pytest.skip("Chromium did not open its debugging port")

            with BrowserSession(port) as session:
                text, _ = session.read(f"file://{fixture}")
                first = find_board_names(text, board)
                assert first == {"Jahmyr Gibbs"}

                # A pick happens between polls.
                fixture.write_text(
                    "<html><body><div>Jahmyr Gibbs Det - RB</div>"
                    "<div>Puka Nacua LAR - WR</div></body></html>"
                )
                text, _ = session.read(f"file://{fixture}")
                second = find_board_names(text, board)

            assert second == {"Jahmyr Gibbs", "Puka Nacua"}
            assert diff_drafted(first, second, "appear") == {"Puka Nacua"}
        finally:
            proc.terminate()
            proc.wait(timeout=10)
