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


# --- Weekly (My Team page) parsing -------------------------------------------
#
# Yahoo renders the same row two ways depending on viewport and page: stacked,
# with slot / matchup / projection each on their own line, and inline, with the
# whole row on one. Both are parsed here and both must produce identical rows —
# that equivalence is what the first test below pins, because a parser that
# only handles the layout the author happened to look at is a parser that
# breaks on somebody else's screen.

STACKED_PAGE = """
My Team
QB
Josh Allen Buf - QB
Sun 1:00 pm vs NYJ
22.45
W/R/T
Jahmyr Gibbs Det - RB Q
Sun 4:25 pm @ GB
15.10
BN
Puka Nacua LAR - WR O
Sun 1:00 pm vs SEA
0.00
BN
Tank Bigsby Jax - RB
Bye
0.00
"""

INLINE_PAGE = """
QB Josh Allen Buf - QB Sun 1:00 pm vs NYJ 22.45
W/R/T Jahmyr Gibbs Det - RB Q Sun 4:25 pm @ GB 15.10
BN Puka Nacua LAR - WR O Sun 1:00 pm vs SEA 0.00
BN Tank Bigsby Jax - RB Bye 0.00
"""


class TestParseWeeklyText:
    def test_both_renderings_agree(self):
        from fantasy_manager.browser_sync import parse_weekly_text
        assert parse_weekly_text(STACKED_PAGE) == parse_weekly_text(INLINE_PAGE)

    def test_reads_slot_status_opponent_and_projection(self):
        from fantasy_manager.browser_sync import parse_weekly_text
        rows = {r["name"]: r for r in parse_weekly_text(STACKED_PAGE)}

        allen = rows["Josh Allen"]
        assert (allen["slot"], allen["status"], allen["opponent"], allen["proj"]) == \
               ("QB", "", "vs NYJ", 22.45)

        gibbs = rows["Jahmyr Gibbs"]
        assert (gibbs["slot"], gibbs["status"], gibbs["opponent"], gibbs["proj"]) == \
               ("W/R/T", "Q", "@GB", 15.10)

    def test_at_sign_opponent_is_parsed(self):
        # Regression: an earlier pattern anchored on \b before the "@", and a
        # word boundary needs a word character on one side — " @" has none, so
        # every away game silently picked up the *next* player's home opponent.
        from fantasy_manager.browser_sync import parse_weekly_text
        rows = {r["name"]: r for r in parse_weekly_text(STACKED_PAGE)}
        assert rows["Jahmyr Gibbs"]["opponent"] == "@GB"

    def test_a_row_does_not_inherit_its_neighbours_numbers(self):
        # Regression: a fixed window of surrounding lines gave the first player
        # the second player's projection, which is invisible in a lineup and
        # wrong every week.
        from fantasy_manager.browser_sync import parse_weekly_text
        rows = {r["name"]: r for r in parse_weekly_text(STACKED_PAGE)}
        assert rows["Josh Allen"]["proj"] == 22.45
        assert rows["Josh Allen"]["opponent"] == "vs NYJ"

    def test_bye_is_flagged_and_carries_no_opponent(self):
        from fantasy_manager.browser_sync import parse_weekly_text
        bigsby = {r["name"]: r for r in parse_weekly_text(STACKED_PAGE)}["Tank Bigsby"]
        assert bigsby["bye"] is True and bigsby["opponent"] is None

    def test_injury_designation_is_kept_not_swallowed_into_the_name(self):
        from fantasy_manager.browser_sync import parse_weekly_text
        rows = {r["name"]: r for r in parse_weekly_text(STACKED_PAGE)}
        assert "Puka Nacua" in rows and rows["Puka Nacua"]["status"] == "O"

    def test_slot_label_never_becomes_part_of_the_name(self):
        from fantasy_manager.browser_sync import parse_weekly_text
        assert all(not r["name"].startswith(("BN ", "QB ", "W/R/T "))
                   for r in parse_weekly_text(INLINE_PAGE))

    def test_missing_projection_is_none_not_zero(self):
        # "No projection on the page" and "projected to score nothing" are
        # different claims and the engine treats them differently.
        from fantasy_manager.browser_sync import parse_weekly_text
        rows = parse_weekly_text("Bijan Robinson Atl - RB\nSun 1:00 pm vs TB\n")
        assert rows[0]["proj"] is None

    def test_empty_page_is_empty_not_an_error(self):
        from fantasy_manager.browser_sync import parse_weekly_text
        assert parse_weekly_text("Nothing here\n") == []

    def test_names_carry_periods_for_adp_matching(self):
        from fantasy_manager.browser_sync import parse_weekly_text
        rows = parse_weekly_text("BN A.J. Brown Phi - WR Sun 1:00 pm vs DAL 12.30\n")
        assert rows[0]["name"] == "A.J. Brown"


# --- The real Yahoo My Team layout -------------------------------------------
#
# tests/fixtures/yahoo_myteam_week1.txt is captured from an actual Yahoo My Team
# page, and it is the reason this parser exists in its current form. The first
# version anchored on "Name TEAM - POS" appearing together on one line, which
# the real page never does — it stacks the row, putting the name two lines above
# a bare "Chi - QB". That parsed zero players off a live page while passing
# every hand-written test, so the captured page is now the test.

def _fixture(name):
    import pathlib
    return (pathlib.Path(__file__).parent / "fixtures" / name).read_text()


class TestRealYahooMyTeamPage:
    @pytest.fixture
    def rows(self):
        from fantasy_manager.browser_sync import parse_weekly_text
        return {r["name"]: r for r in parse_weekly_text(_fixture("yahoo_myteam_week1.txt"))}

    def test_parses_every_player_on_the_page(self, rows):
        assert len(rows) == 15

    def test_reads_the_full_row(self, rows):
        qb = rows["Caleb Williams"]
        assert (qb["pos"], qb["team"], qb["slot"]) == ("QB", "CHI", "QB")
        assert (qb["opponent"], qb["proj"], qb["bye_week"]) == ("@CAR", 18.35, 10)

    def test_injury_designation_glued_to_the_name_is_recovered(self, rows):
        # Renders as "Jeremiyah LoveQVideo ForecastNew Player Note" — the Q has
        # no separator before it, and the name must not absorb it either.
        assert rows["Jeremiyah Love"]["status"] == "Q"
        assert rows["Jeremiyah Love"]["proj"] == 13.02

    def test_note_chrome_is_not_mistaken_for_a_status(self, rows):
        # "Kyle Pitts Sr.No new player Notes" and "CeeDee LambPlayer Note" start
        # with N and P; neither is a designation.
        assert rows["Kyle Pitts Sr."]["status"] == ""
        assert rows["CeeDee Lamb"]["status"] == ""

    def test_name_suffixes_survive(self, rows):
        # Exact-name matching is what attaches ADP value, so "Sr." must stay.
        assert "Kyle Pitts Sr." in rows and "Aaron Jones Sr." in rows

    def test_flex_and_bench_slots_are_read(self, rows):
        assert rows["Jadarian Price"]["slot"] == "W/R/T"
        assert rows["Josh Downs"]["slot"] == "BN"

    def test_defense_rows_parse(self, rows):
        assert rows["Seahawks"]["pos"] == "DEF"
        assert rows["Seahawks"]["slot"] == "DEF"
        assert rows["Broncos"]["slot"] == "BN"

    def test_home_and_away_opponents(self, rows):
        assert rows["Justin Jefferson"]["opponent"] == "vs GB"
        assert rows["Breece Hall"]["opponent"] == "@TEN"

    def test_projection_is_proj_pts_not_fan_pts(self):
        """The columns run Bye, Fan Pts, Proj Pts, then percentages.

        Fan Pts is "-" in week 1 but a real number from week 2 on, and it sits
        *before* the projection. Taking the first decimal after the anchor would
        silently return points already scored for the rest of the season.
        """
        from fantasy_manager.browser_sync import parse_weekly_text
        scored = _fixture("yahoo_myteam_week1.txt").replace(
            "Chi - QB\nSun 1:00 pm @ Car\n10\n–\n18.35",
            "Chi - QB\nSun 1:00 pm @ Car\n10\n24.60\n18.35")
        rows = {r["name"]: r for r in parse_weekly_text(scored)}
        assert rows["Caleb Williams"]["proj"] == 18.35

    def test_inline_pages_still_parse(self):
        # The league-rosters and draft-room pages really do put name and
        # position on one line; that path must survive the stacked one.
        from fantasy_manager.browser_sync import parse_weekly_text
        rows = parse_weekly_text(INLINE_PAGE)
        assert {r["name"] for r in rows} >= {"Josh Allen", "Jahmyr Gibbs"}


# --- Row shapes the week-1 capture didn't contain ----------------------------
#
# yahoo_myteam_week5_kicker.txt covers what the first capture could not: a
# kicker slot, a player on IR, a player on bye, a player ruled Out while still
# sitting in a starting slot, a multi-position eligibility, and — the one that
# only appears from week 2 — a populated Fan Pts column sitting immediately
# before Proj Pts.
#
# UNLIKE the week-1 fixture, this one is CONSTRUCTED rather than captured. It
# follows the row layout the real page established and extends it to rows that
# page did not contain. That makes it a real test of the parser's handling of
# those shapes and NOT evidence that Yahoo renders them this way — if one turns
# out wrong on a live page, this fixture is what to correct.

class TestKickerLeagueMidSeasonPage:
    @pytest.fixture
    def rows(self):
        from fantasy_manager.browser_sync import parse_weekly_text
        return {r["name"]: r
                for r in parse_weekly_text(_fixture("yahoo_myteam_week5_kicker.txt"))}

    def test_parses_every_row(self, rows):
        assert len(rows) == 12

    def test_kicker_is_read_as_a_kicker(self, rows):
        butker = rows["Harrison Butker"]
        assert (butker["pos"], butker["slot"], butker["proj"]) == ("K", "K", 8.60)

    def test_ir_player_carries_slot_and_status(self, rows):
        assert rows["Puka Nacua"]["slot"] == "IR"
        assert rows["Puka Nacua"]["status"] == "IR"

    def test_bye_row_has_no_opponent_and_no_projection(self, rows):
        collins = rows["Nico Collins"]
        assert collins["bye"] is True
        assert collins["opponent"] is None
        # Both point columns render as a dash on a bye. "No projection" must not
        # come back as 0.0, which would read as a real prediction of zero.
        assert collins["proj"] is None

    def test_out_designation_is_read(self, rows):
        assert rows["Bijan Robinson"]["status"] == "O"

    def test_multi_position_eligibility_keeps_the_player(self, rows):
        # Regression: the anchor required a single position, so "NO - TE,QB" did
        # not match at all and Taysom Hill vanished from the roster entirely —
        # the lineup was then computed as though he weren't on the team.
        assert "Taysom Hill" in rows
        assert rows["Taysom Hill"]["pos"] == "TE"

    def test_projection_is_proj_pts_with_fan_pts_populated(self, rows):
        # From week 2 on, Fan Pts holds real points and sits before Proj Pts.
        # Every one of these is the SECOND decimal in its row.
        assert rows["Josh Allen"]["proj"] == 21.40        # Fan Pts was 24.60
        assert rows["Bijan Robinson"]["proj"] == 17.80    # Fan Pts was 18.20
        assert rows["Ja'Marr Chase"]["proj"] == 18.90     # Fan Pts was 22.40

    def test_bye_week_column_is_captured(self, rows):
        assert rows["Josh Allen"]["bye_week"] == 7
        assert rows["Harrison Butker"]["bye_week"] == 10

    def test_defense_section_after_the_offense_table(self, rows):
        assert rows["Ravens"]["pos"] == "DEF" and rows["Ravens"]["slot"] == "DEF"
