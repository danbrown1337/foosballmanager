"""Tests for the draft board: loading, position aliasing, tiering,
replacement level, research notes, and draft-state persistence."""
import json

from fantasy_manager.board import (
    apply_draft_state,
    apply_notes,
    assign_tiers,
    build_board,
    load_draft_state,
    load_player_notes,
    load_players,
    replacement_ranks,
    save_draft_state,
    scarcity_report,
)

from conftest import make_config, make_player


class TestLoadPlayers:
    def test_reads_every_row(self, adp_csv):
        assert len(load_players(adp_csv)) == 6

    def test_normalizes_source_position_labels(self, adp_csv):
        by_name = {p.name: p for p in load_players(adp_csv)}
        # The source data labels kickers "PK" and defenses "DST"; the rest of
        # the codebase only ever deals in K/DEF.
        assert by_name["Epsilon Kick"].pos == "K"
        assert by_name["Zeta Defense"].pos == "DEF"

    def test_types_are_coerced(self, adp_csv):
        p = load_players(adp_csv)[0]
        assert isinstance(p.rank, int)
        assert isinstance(p.adp, float)

    def test_undrafted_by_default(self, adp_csv):
        assert all(p.drafted_by is None for p in load_players(adp_csv))


class TestNotes:
    def test_bust_pushes_adp_later(self, notes_csv):
        players = [make_player("Alpha Back", "RB", 1.5)]
        apply_notes(players, load_player_notes(notes_csv))
        assert players[0].adjustment == 20
        assert players[0].adjusted_adp == 21.5

    def test_breakout_pulls_adp_earlier(self, notes_csv):
        players = [make_player("Beta Wide", "WR", 20.0)]
        apply_notes(players, load_player_notes(notes_csv))
        assert players[0].adjustment == -8
        assert players[0].adjusted_adp == 12.0

    def test_raw_adp_is_never_mutated(self, notes_csv):
        """Display always shows the market's number next to the adjusted one."""
        players = [make_player("Alpha Back", "RB", 1.5)]
        apply_notes(players, load_player_notes(notes_csv))
        assert players[0].adp == 1.5

    def test_unlisted_players_are_untouched(self, notes_csv):
        players = [make_player("Nobody Special", "WR", 50.0)]
        apply_notes(players, load_player_notes(notes_csv))
        assert players[0].adjustment == 0.0
        assert players[0].note_tag is None

    def test_missing_notes_file_is_not_fatal(self, tmp_path):
        assert load_player_notes(str(tmp_path / "absent.csv")) == {}


class TestTiers:
    def test_small_gaps_stay_in_one_tier(self):
        players = [make_player(f"P{i}", "RB", adp) for i, adp in enumerate([1.0, 1.5, 2.0])]
        assign_tiers(players)
        assert {p.tier for p in players} == {1}

    def test_large_gap_starts_a_new_tier(self):
        players = [make_player("Early", "RB", 1.0), make_player("Late", "RB", 40.0)]
        assign_tiers(players)
        assert players[0].tier == 1
        assert players[1].tier == 2

    def test_late_round_needs_a_bigger_absolute_gap(self):
        """A 4-pick gap breaks a tier at ADP 1 but not at ADP 100, because the
        threshold is relative to where you are in the draft."""
        late = [make_player("A", "WR", 100.0), make_player("B", "WR", 104.0)]
        assign_tiers(late)
        assert late[0].tier == late[1].tier

        early = [make_player("A", "WR", 4.0), make_player("B", "WR", 8.0)]
        assign_tiers(early)
        assert early[0].tier != early[1].tier

    def test_tiers_are_per_position(self):
        players = [make_player("RB1", "RB", 1.0), make_player("WR1", "WR", 60.0)]
        assign_tiers(players)
        # The WR is alone at his position, so he is his position's Tier 1 even
        # though he'd be a much later tier on an overall board.
        assert players[1].tier == 1


class TestReplacementRanks:
    def test_scales_with_league_size(self):
        small = replacement_ranks(make_config(num_teams=8))
        big = replacement_ranks(make_config(num_teams=14))
        assert big["RB"] > small["RB"]

    def test_flex_is_split_toward_rb_and_wr(self):
        """FLEX splits ~60/35/5 RB/WR/TE, so RB's replacement rank runs
        deeper than WR's despite identical starter counts."""
        repl = replacement_ranks(make_config(num_teams=10))
        assert repl["RB"] > repl["WR"] > repl["TE"]

    def test_never_returns_zero(self):
        repl = replacement_ranks(make_config(starters={"QB": 1, "K": 1}, num_teams=1))
        assert all(v >= 1 for v in repl.values())


class TestDraftState:
    def test_roundtrip(self, tmp_path):
        path = str(tmp_path / "state.json")
        save_draft_state({"drafted": {"Alpha Back": "mine"}}, path)
        assert load_draft_state(path)["drafted"]["Alpha Back"] == "mine"

    def test_missing_state_starts_empty(self, tmp_path):
        assert load_draft_state(str(tmp_path / "none.json")) == {"drafted": {}}

    def test_apply_stamps_players(self):
        players = [make_player("Alpha Back", "RB", 1.5), make_player("Beta Wide", "WR", 2.0)]
        apply_draft_state(players, {"drafted": {"Alpha Back": "mine"}})
        assert players[0].drafted_by == "mine"
        assert players[1].drafted_by is None

    def test_unknown_names_in_state_are_ignored(self):
        """A player drafted who isn't on our 190-deep board shouldn't crash."""
        players = [make_player("Alpha Back", "RB", 1.5)]
        apply_draft_state(players, {"drafted": {"Some Deep Sleeper": "rival"}})
        assert players[0].drafted_by is None

    def test_state_file_is_valid_json(self, tmp_path):
        path = str(tmp_path / "state.json")
        save_draft_state({"drafted": {"A": "mine"}}, path)
        assert json.loads(open(path).read())["drafted"] == {"A": "mine"}


class TestScarcityReport:
    def test_one_line_per_position(self, config):
        players = [make_player("Alpha Back", "RB", 1.5), make_player("Beta Wide", "WR", 2.0)]
        assign_tiers(players)
        lines = scarcity_report(players, config)
        assert len(lines) == 6

    def test_exhausted_position_is_reported(self, config):
        players = [make_player("Alpha Back", "RB", 1.5)]
        assign_tiers(players)
        lines = scarcity_report(players, config)
        assert any(line.startswith("QB: none left") for line in lines)

    def test_drafted_players_leave_the_available_pool(self, config):
        players = [make_player("A", "RB", 1.0), make_player("B", "RB", 2.0)]
        assign_tiers(players)
        before = scarcity_report(players, config)[1]
        players[0].drafted_by = "rival"
        after = scarcity_report(players, config)[1]
        assert before != after


class TestBuildBoard:
    def test_wires_load_notes_and_tiers_together(self, adp_csv, notes_csv, tmp_path):
        cfg = tmp_path / "league.yaml"
        cfg.write_text(
            "league:\n  num_teams: 10\n  scoring: ppr\n"
            "roster:\n  starters:\n    QB: 1\n    RB: 2\n  bench: 6\n  ir: 1\n"
        )
        players, config = build_board(str(cfg), adp_csv, notes_csv)
        by_name = {p.name: p for p in players}
        assert config["league"]["num_teams"] == 10
        assert by_name["Alpha Back"].adjustment == 20      # notes applied
        assert all(p.tier > 0 for p in players)            # tiers assigned
