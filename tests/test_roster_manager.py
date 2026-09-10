"""Tests for the post-draft roster manager: CSV loading and the
bye-week / summary / overachiever views."""
import argparse

import pytest

from fantasy_manager import profiles
from fantasy_manager.board import build_board

from fantasy_manager import roster_manager
from fantasy_manager.roster_manager import cmd_byeweeks, cmd_overachievers, cmd_summary, load_my_roster

from conftest import make_player


def args(**kwargs):
    return argparse.Namespace(**kwargs)


def write_roster(tmp_path, rows):
    path = tmp_path / "my_roster.csv"
    path.write_text("name,pos,team\n" + "".join(f"{n},{p},{t}\n" for n, p, t in rows))
    return str(path)


class TestLoadMyRoster:
    def test_reads_rows(self, tmp_path):
        path = write_roster(tmp_path, [("Alpha", "RB", "DET"), ("Beta", "WR", "LAR")])
        assert len(load_my_roster(path)) == 2

    def test_normalizes_positions(self, tmp_path):
        path = write_roster(tmp_path, [("Kicker", "PK", "DAL"), ("Defense", "DST", "SEA")])
        assert [r["pos"] for r in load_my_roster(path)] == ["K", "DEF"]

    def test_missing_file_is_empty_not_an_error(self, tmp_path):
        assert load_my_roster(str(tmp_path / "nope.csv")) == []

    def test_header_only_file_is_empty(self, tmp_path):
        assert load_my_roster(write_roster(tmp_path, [])) == []


class TestSummary:
    def test_prompts_when_no_roster_on_file(self, monkeypatch, capsys):
        monkeypatch.setattr(roster_manager, "load_my_roster", lambda *a, **k: [])
        cmd_summary(args())
        assert "No roster on file yet" in capsys.readouterr().out

    def test_groups_by_position(self, monkeypatch, capsys):
        roster = [
            {"name": "Alpha", "pos": "RB", "team": "DET"},
            {"name": "Beta", "pos": "RB", "team": "ATL"},
            {"name": "Gamma", "pos": "WR", "team": "LAR"},
        ]
        monkeypatch.setattr(roster_manager, "load_my_roster", lambda *a, **k: roster)
        cmd_summary(args())
        out = capsys.readouterr().out
        assert "Roster (3 players)" in out
        assert "RB   [2]" in out
        assert "WR   [1]" in out
        assert "QB   [0]" in out


class TestByeWeeks:
    """The question is whether a bye leaves you unable to field a legal lineup.

    It used to be "are two players at one position off the same week", which is
    a different question and got both answers wrong on the real captured
    roster: it flagged week 5, when two BENCH tight ends were off and the
    starter was fine, and said nothing about week 10, when the roster's only
    quarterback was out. These pin the rule that replaced it.
    """

    # Deep enough to satisfy the default starters (QB 1, RB 2, WR 2, TE 1,
    # FLEX 2, DEF 1) — otherwise every week is short and the tests would be
    # measuring roster size rather than byes.
    def _deep_roster(self):
        return [
            {"name": "QB1", "pos": "QB", "team": "LAR"},    # week 11
            {"name": "QB2", "pos": "QB", "team": "SEA"},    # week 11
            {"name": "RB1", "pos": "RB", "team": "KC"},     # week 5
            {"name": "RB2", "pos": "RB", "team": "BUF"},    # week 7
            {"name": "RB3", "pos": "RB", "team": "DET"},    # week 6
            {"name": "RB4", "pos": "RB", "team": "ATL"},    # week 11
            {"name": "WR1", "pos": "WR", "team": "CAR"},    # week 5
            {"name": "WR2", "pos": "WR", "team": "MIA"},    # week 6
            {"name": "WR3", "pos": "WR", "team": "CIN"},    # week 6
            {"name": "WR4", "pos": "WR", "team": "MIN"},    # week 6
            {"name": "TE1", "pos": "TE", "team": "LAR"},    # week 11
            {"name": "TE2", "pos": "TE", "team": "SEA"},    # week 11
            {"name": "DEF1", "pos": "DEF", "team": "ATL"},  # week 11
            {"name": "DEF2", "pos": "DEF", "team": "KC"},   # week 5
        ]

    def test_flags_the_week_a_bye_leaves_a_slot_short(self, monkeypatch, capsys):
        # Both quarterbacks are off in week 11, so the QB slot cannot be filled.
        roster = self._deep_roster()
        monkeypatch.setattr(roster_manager, "load_my_roster", lambda *a, **k: roster)
        cmd_byeweeks(args())
        out = capsys.readouterr().out
        assert "Week 11" in out
        assert "QB1" in out and "QB2" in out
        assert "short a starter" in out

    def test_bench_players_off_together_are_not_a_shortage(self, monkeypatch, capsys):
        """The false positive the old rule produced on the real roster.

        Two tight ends off the same week reads as a pileup, but with a third TE
        available the starting slot is still filled — nothing to act on.
        """
        roster = [
            {"name": "QB1", "pos": "QB", "team": "LAR"},
            {"name": "RB1", "pos": "RB", "team": "LAR"},
            {"name": "RB2", "pos": "RB", "team": "SEA"},
            {"name": "WR1", "pos": "WR", "team": "LAR"},
            {"name": "WR2", "pos": "WR", "team": "SEA"},
            {"name": "TE1", "pos": "TE", "team": "KC"},    # week 5, bench
            {"name": "TE2", "pos": "TE", "team": "CAR"},   # week 5, bench
            {"name": "TE3", "pos": "TE", "team": "LAR"},   # week 11, still there
            {"name": "DEF1", "pos": "DEF", "team": "LAR"},
        ]
        monkeypatch.setattr(roster_manager, "load_my_roster", lambda *a, **k: roster)
        cmd_byeweeks(args())
        out = capsys.readouterr().out
        assert "Week 5" not in out

    def test_a_lone_starter_going_on_bye_is_flagged(self, monkeypatch, capsys):
        """The false negative the old rule produced: one quarterback, one bye,
        no second player at the position to make it look like a pileup — and a
        guaranteed zero in the QB slot that week."""
        roster = self._deep_roster()
        roster = [r for r in roster if r["name"] != "QB2"]
        monkeypatch.setattr(roster_manager, "load_my_roster", lambda *a, **k: roster)
        cmd_byeweeks(args())
        out = capsys.readouterr().out
        assert "Week 11" in out and "QB1" in out

    def test_a_roster_that_survives_every_week_says_so(self, monkeypatch, capsys):
        roster = [
            {"name": "QB1", "pos": "QB", "team": "LAR"},    # week 11
            {"name": "QB2", "pos": "QB", "team": "KC"},     # week 5
            {"name": "RB1", "pos": "RB", "team": "KC"},
            {"name": "RB2", "pos": "RB", "team": "BUF"},
            {"name": "RB3", "pos": "RB", "team": "LAR"},
            {"name": "RB4", "pos": "RB", "team": "DET"},
            {"name": "WR1", "pos": "WR", "team": "CAR"},
            {"name": "WR2", "pos": "WR", "team": "MIA"},
            {"name": "WR3", "pos": "WR", "team": "LAR"},
            {"name": "WR4", "pos": "WR", "team": "BUF"},
            {"name": "TE1", "pos": "TE", "team": "KC"},
            {"name": "TE2", "pos": "TE", "team": "LAR"},
            {"name": "DEF1", "pos": "DEF", "team": "KC"},
            {"name": "DEF2", "pos": "DEF", "team": "LAR"},
        ]
        monkeypatch.setattr(roster_manager, "load_my_roster", lambda *a, **k: roster)
        cmd_byeweeks(args())
        assert "field a legal lineup every week" in capsys.readouterr().out

    def test_unknown_team_has_no_bye_and_is_skipped(self, monkeypatch, capsys):
        roster = [{"name": "Alpha", "pos": "RB", "team": "FA"}]
        monkeypatch.setattr(roster_manager, "load_my_roster", lambda *a, **k: roster)
        cmd_byeweeks(args())
        # No bye week is known for "FA", so no week can be reported short.
        assert "Week" not in capsys.readouterr().out.split("short:")[1]

    def test_no_roster_prompts(self, monkeypatch, capsys):
        monkeypatch.setattr(roster_manager, "load_my_roster", lambda *a, **k: [])
        cmd_byeweeks(args())
        assert "No roster on file yet" in capsys.readouterr().out


class TestOverachievers:
    def test_lists_only_breakout_tagged_players(self, monkeypatch, capsys):
        board = [
            make_player("Riser", "WR", 100.0, adjustment=-10.0,
                        note_tag="breakout", note="Path to volume"),
            make_player("Faller", "RB", 20.0, adjustment=15.0,
                        note_tag="bust", note="Committee risk"),
        ]
        monkeypatch.setattr(roster_manager, "build_board", lambda *a, **k: (board, {}))
        monkeypatch.setattr(roster_manager, "apply_draft_state", lambda *a, **k: {})
        cmd_overachievers(args(pos=None, top=10))
        out = capsys.readouterr().out
        assert "Riser" in out
        assert "Faller" not in out

    def test_sorted_by_biggest_expected_beat(self, monkeypatch, capsys):
        board = [
            make_player("Small", "WR", 100.0, adjustment=-2.0, note_tag="breakout", note="a"),
            make_player("Big", "WR", 100.0, adjustment=-20.0, note_tag="breakout", note="b"),
        ]
        monkeypatch.setattr(roster_manager, "build_board", lambda *a, **k: (board, {}))
        monkeypatch.setattr(roster_manager, "apply_draft_state", lambda *a, **k: {})
        cmd_overachievers(args(pos=None, top=10))
        out = capsys.readouterr().out
        assert out.index("Big") < out.index("Small")

    def test_position_filter(self, monkeypatch, capsys):
        board = [
            make_player("Riser", "WR", 100.0, adjustment=-10.0, note_tag="breakout", note="a"),
            make_player("Back", "RB", 100.0, adjustment=-10.0, note_tag="breakout", note="b"),
        ]
        monkeypatch.setattr(roster_manager, "build_board", lambda *a, **k: (board, {}))
        monkeypatch.setattr(roster_manager, "apply_draft_state", lambda *a, **k: {})
        cmd_overachievers(args(pos="rb", top=10))
        out = capsys.readouterr().out
        assert "Back" in out and "Riser" not in out


class TestFreeAgentPool:
    """The pool `waivers` ranks has to exclude everyone already rostered —
    including your own players, whichever file they are recorded in."""

    @pytest.fixture
    def sandbox(self, tmp_path, monkeypatch):
        monkeypatch.setattr(profiles, "PROFILES_DIR", str(tmp_path / "profiles"))
        monkeypatch.delenv(profiles.ENV_VAR, raising=False)
        profiles.ensure_profile()
        return tmp_path

    def test_excludes_players_on_the_weekly_import(self, sandbox):
        # Regression: the pool was filtered against my_roster.csv only, so a
        # roster kept current by the weekly import — the normal in-season
        # case — had its own players recommended back as waiver targets.
        board, _ = build_board()
        mine = board[0].name
        with open(profiles.weekly_path(), "w", newline="") as f:
            f.write("name,pos,team,slot,status,opponent,proj,bye\n")
            f.write(f"{mine},{board[0].pos},{board[0].team},BN,,,10.0,False\n")

        available, _ = roster_manager.load_free_agents()
        assert mine not in {p.name for p in available}

    def test_excludes_players_on_rival_rosters(self, sandbox):
        board, _ = build_board()
        theirs = board[0].name
        with open(profiles.league_rosters_path(), "w", newline="") as f:
            f.write("team_name,manager,name,pos,team\n")
            f.write(f"Rivals,Someone,{theirs},{board[0].pos},{board[0].team}\n")

        available, source = roster_manager.load_free_agents()
        assert theirs not in {p.name for p in available}
        assert "all known rosters" in source

    def test_says_so_when_it_only_knows_your_own_roster(self, sandbox):
        _, source = roster_manager.load_free_agents()
        assert "your roster only" in source
