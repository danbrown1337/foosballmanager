"""Tests for the post-draft roster manager: CSV loading and the
bye-week / summary / overachiever views."""
import argparse

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
    def test_flags_two_players_at_one_position_on_the_same_bye(self, monkeypatch, capsys):
        # KC and CAR both bye in week 5.
        roster = [
            {"name": "Alpha", "pos": "RB", "team": "KC"},
            {"name": "Beta", "pos": "RB", "team": "CAR"},
        ]
        monkeypatch.setattr(roster_manager, "load_my_roster", lambda *a, **k: roster)
        cmd_byeweeks(args())
        out = capsys.readouterr().out
        assert "Week 5" in out
        assert "Alpha" in out and "Beta" in out

    def test_spread_out_byes_are_not_flagged(self, monkeypatch, capsys):
        roster = [
            {"name": "Alpha", "pos": "RB", "team": "KC"},    # week 5
            {"name": "Beta", "pos": "WR", "team": "BUF"},    # week 7
        ]
        monkeypatch.setattr(roster_manager, "load_my_roster", lambda *a, **k: roster)
        cmd_byeweeks(args())
        assert "well spread out" in capsys.readouterr().out

    def test_same_week_different_positions_is_not_a_pileup(self, monkeypatch, capsys):
        """One RB and one WR off in week 5 is survivable — only 2+ at the same
        position is a real starting-lineup hole."""
        roster = [
            {"name": "Alpha", "pos": "RB", "team": "KC"},
            {"name": "Beta", "pos": "WR", "team": "CAR"},
        ]
        monkeypatch.setattr(roster_manager, "load_my_roster", lambda *a, **k: roster)
        cmd_byeweeks(args())
        assert "well spread out" in capsys.readouterr().out

    def test_unknown_team_is_skipped(self, monkeypatch, capsys):
        roster = [{"name": "Alpha", "pos": "RB", "team": "FA"}]
        monkeypatch.setattr(roster_manager, "load_my_roster", lambda *a, **k: roster)
        cmd_byeweeks(args())
        assert "well spread out" in capsys.readouterr().out


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
