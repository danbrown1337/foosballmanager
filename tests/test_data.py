"""Integrity checks on the shipped 2026 data and the default league config.

These guard the CSVs themselves rather than the code — a typo'd player name
or a missing team abbreviation degrades the tool silently, so it's worth
catching in CI instead of on draft night.
"""
import pytest
import yaml

from fantasy_manager.board import (
    DEFAULT_ADP,
    DEFAULT_CONFIG,
    DEFAULT_NOTES,
    load_config,
    load_player_notes,
    load_players,
)
from fantasy_manager.bye_weeks import BYE_WEEKS

VALID_POSITIONS = {"QB", "RB", "WR", "TE", "K", "DEF"}
VALID_TAGS = {"bust", "injury_watch", "breakout", "value_note"}

# Breakout calls on players who sit outside the top-190 ADP board. They load
# fine but never attach to a Player, so the autopilot can't act on them —
# they're waiver-wire notes, kept deliberately. Anything NOT in this list
# failing the match check is a genuine typo or a stale name.
NOTES_FOR_PLAYERS_OFF_THE_BOARD = {
    "Adonai Mitchell",
    "Ryan Flournoy",
    "Terrance Ferguson",
}


@pytest.fixture(scope="module")
def players():
    return load_players(DEFAULT_ADP)


@pytest.fixture(scope="module")
def notes():
    return load_player_notes(DEFAULT_NOTES)


class TestAdpBoard:
    def test_board_is_deep_enough_for_a_full_draft(self, players):
        # 10 teams x 16 roster spots = 160; the board ships 190.
        assert len(players) >= 160

    def test_ranks_are_unique_and_contiguous(self, players):
        ranks = sorted(p.rank for p in players)
        assert ranks == list(range(1, len(players) + 1))

    def test_adp_never_decreases_as_rank_increases(self, players):
        ordered = [p.adp for p in sorted(players, key=lambda p: p.rank)]
        assert all(a <= b for a, b in zip(ordered, ordered[1:]))

    def test_every_position_is_recognized(self, players):
        assert {p.pos for p in players} <= VALID_POSITIONS

    def test_every_startable_position_is_represented(self, players):
        assert {p.pos for p in players} == VALID_POSITIONS

    def test_no_duplicate_player_names(self, players):
        names = [p.name for p in players]
        assert len(set(names)) == len(names)

    def test_adp_values_are_positive(self, players):
        assert all(p.adp > 0 for p in players)


class TestByeWeeks:
    def test_all_32_nfl_teams_are_covered(self):
        assert len(BYE_WEEKS) == 32

    def test_byes_fall_in_a_plausible_window(self):
        assert all(5 <= week <= 14 for week in BYE_WEEKS.values())

    def test_every_drafted_player_has_a_bye_week(self, players):
        """Otherwise the bye-week pileup check silently ignores them. 'FA'
        (free agent) is the one legitimate exception."""
        missing = {p.team for p in players if p.team not in BYE_WEEKS and p.team != "FA"}
        assert missing == set()


class TestPlayerNotes:
    def test_tags_are_from_the_known_set(self, notes):
        assert {n["tag"] for n in notes.values()} <= VALID_TAGS

    def test_adjustments_are_positive_magnitudes(self, notes):
        """The CSV stores magnitude only; apply_notes() decides the sign from
        the tag, so a negative value here would flip a call's meaning."""
        assert all(n["adjustment"] > 0 for n in notes.values())

    def test_adjustments_are_sanely_sized(self, notes):
        assert all(n["adjustment"] <= 60 for n in notes.values())

    def test_every_note_has_its_reasoning(self, notes):
        assert all(n["note"].strip() for n in notes.values())

    def test_note_names_match_the_board(self, players, notes):
        board = {p.name for p in players}
        unmatched = set(notes) - board - NOTES_FOR_PLAYERS_OFF_THE_BOARD
        assert unmatched == set(), f"notes reference players not on the board: {sorted(unmatched)}"

    def test_off_board_exemptions_are_still_real_notes(self, notes):
        """Keeps the allowlist honest — remove a name from the CSV and the
        exemption should go with it."""
        assert NOTES_FOR_PLAYERS_OFF_THE_BOARD <= set(notes)


class TestLeagueConfig:
    def test_parses(self):
        assert load_config(DEFAULT_CONFIG)

    def test_has_the_sections_the_code_reads(self):
        config = load_config(DEFAULT_CONFIG)
        assert {"league", "roster", "autopilot"} <= set(config)
        assert "starters" in config["roster"]

    def test_starter_positions_are_recognized(self):
        starters = load_config(DEFAULT_CONFIG)["roster"]["starters"]
        assert set(starters) <= VALID_POSITIONS | {"FLEX"}

    def test_autopilot_settings_are_valid_choices(self):
        ap = load_config(DEFAULT_CONFIG)["autopilot"]
        assert ap["strategy"] in {"best_player_available", "robust_rb", "zero_rb"}
        assert ap["risk_tolerance"] in {"safe_floor", "balanced", "chase_upside"}

    def test_roster_is_big_enough_for_the_starting_lineup(self):
        config = load_config(DEFAULT_CONFIG)
        roster = config["roster"]
        total = sum(roster["starters"].values()) + roster["bench"] + roster["ir"]
        assert total > sum(roster["starters"].values())

    def test_yaml_is_valid_utf8_and_loads_as_a_mapping(self):
        with open(DEFAULT_CONFIG, encoding="utf-8") as f:
            assert isinstance(yaml.safe_load(f), dict)
