"""Tests for the lowball trade generator: roster loading, surplus/deficit
detection, and the offer construction that decides how lopsided an ask is."""
from fantasy_manager.trade_targeter import (
    build_offers_for_team,
    load_league_rosters,
    surplus_and_deficit,
)

from conftest import make_config, make_player


def roster(*pairs):
    return [{"name": n, "pos": p, "team": "FA"} for n, p in pairs]


class TestLoadLeagueRosters:
    def test_groups_players_by_team(self, tmp_path):
        path = tmp_path / "league.csv"
        path.write_text(
            "team_name,manager,name,pos,team\n"
            "Sharks,Al,Alpha,RB,DET\n"
            "Sharks,Al,Beta,WR,LAR\n"
            "Bears,Bo,Gamma,QB,BUF\n"
        )
        teams = load_league_rosters(str(path))
        assert set(teams) == {"Sharks", "Bears"}
        assert len(teams["Sharks"]) == 2

    def test_normalizes_positions(self, tmp_path):
        path = tmp_path / "league.csv"
        path.write_text("team_name,manager,name,pos,team\nSharks,Al,Kicker,PK,DAL\n")
        assert load_league_rosters(str(path))["Sharks"][0]["pos"] == "K"

    def test_blank_rows_are_skipped(self, tmp_path):
        path = tmp_path / "league.csv"
        path.write_text("team_name,manager,name,pos,team\n,,,,\nSharks,Al,Alpha,RB,DET\n")
        assert list(load_league_rosters(str(path))) == ["Sharks"]

    def test_missing_file_is_empty(self, tmp_path):
        assert load_league_rosters(str(tmp_path / "nope.csv")) == {}


class TestSurplusAndDeficit:
    def test_deep_position_is_surplus(self):
        config = make_config(starters={"QB": 1, "RB": 2, "WR": 2, "TE": 1})
        # 5 RBs against a 2-start requirement (+0.5 flex fuzz) is a stockpile.
        surplus, _ = surplus_and_deficit(
            roster(("A", "RB"), ("B", "RB"), ("C", "RB"), ("D", "RB"), ("E", "RB")), config
        )
        assert "RB" in surplus

    def test_thin_position_is_deficit(self):
        config = make_config(starters={"QB": 1, "RB": 2, "WR": 2, "TE": 1})
        _, deficit = surplus_and_deficit(roster(("A", "RB")), config)
        assert "WR" in deficit and "TE" in deficit and "QB" in deficit

    def test_a_position_is_never_both(self):
        config = make_config(starters={"QB": 1, "RB": 2, "WR": 2, "TE": 1})
        surplus, deficit = surplus_and_deficit(
            roster(*[("P%d" % i, "RB") for i in range(6)]), config
        )
        assert not set(surplus) & set(deficit)

    def test_kickers_and_defenses_are_ignored(self):
        """Nobody trades for a kicker — only QB/RB/WR/TE are considered."""
        config = make_config(starters={"QB": 1, "RB": 2, "WR": 2, "TE": 1, "K": 1})
        surplus, deficit = surplus_and_deficit(
            roster(*[("K%d" % i, "K") for i in range(5)]), config
        )
        assert "K" not in surplus and "K" not in deficit


class TestBuildOffers:
    config = make_config(starters={"QB": 1, "RB": 2, "WR": 2, "TE": 1})

    # Their roster: RB-heavy, WR-thin — the classic lowball setup.
    their_roster = roster(
        ("Their Stud RB", "RB"), ("Their RB2", "RB"), ("Their RB3", "RB"),
        ("Their RB4", "RB"), ("Their RB5", "RB"),
    )

    def adp(self, **overrides):
        board = {
            "Their Stud RB": make_player("Their Stud RB", "RB", 5.0),
            "Their RB2": make_player("Their RB2", "RB", 60.0),
            "Their RB3": make_player("Their RB3", "RB", 70.0),
            "Their RB4": make_player("Their RB4", "RB", 80.0),
            "Their RB5": make_player("Their RB5", "RB", 90.0),
        }
        board.update(overrides)
        return board

    def test_offers_their_best_player_at_the_surplus_position(self):
        adp = self.adp(**{"My Spare WR": make_player("My Spare WR", "WR", 150.0)})
        offers = build_offers_for_team(
            "Sharks", self.their_roster, roster(("My Spare WR", "WR")), adp, self.config, 3
        )
        assert offers and "Their Stud RB" in offers[0]

    def test_big_gap_reads_as_genuinely_lopsided(self):
        adp = self.adp(**{"My Spare WR": make_player("My Spare WR", "WR", 150.0)})
        offers = build_offers_for_team(
            "Sharks", self.their_roster, roster(("My Spare WR", "WR")), adp, self.config, 1
        )
        assert "genuinely lopsided in your favor" in offers[0]

    def test_small_gap_reads_as_a_mild_lowball(self):
        adp = self.adp(**{"My Spare WR": make_player("My Spare WR", "WR", 25.0)})
        offers = build_offers_for_team(
            "Sharks", self.their_roster, roster(("My Spare WR", "WR")), adp, self.config, 1
        )
        assert "a mild lowball" in offers[0]

    def test_warns_when_the_offer_actually_favors_them(self):
        """Giving up more value than you get back is the one outcome the tool
        must never quietly recommend."""
        adp = self.adp(**{"My Stud WR": make_player("My Stud WR", "WR", 1.0)})
        offers = build_offers_for_team(
            "Sharks", self.their_roster, roster(("My Stud WR", "WR")), adp, self.config, 1
        )
        assert "don't send this one" in offers[0]

    def test_respects_the_offer_count(self):
        adp = self.adp(**{
            "My Spare WR": make_player("My Spare WR", "WR", 150.0),
            "My Spare TE": make_player("My Spare TE", "TE", 160.0),
        })
        offers = build_offers_for_team(
            "Sharks", self.their_roster, roster(("My Spare WR", "WR"), ("My Spare TE", "TE")),
            adp, self.config, 1
        )
        assert len(offers) == 1

    def test_balanced_roster_yields_no_angle(self):
        balanced = roster(("A", "RB"), ("B", "RB"), ("C", "WR"), ("D", "WR"), ("E", "QB"), ("F", "TE"))
        offers = build_offers_for_team(
            "Sharks", balanced, roster(("My Spare WR", "WR")), self.adp(), self.config, 3
        )
        assert offers == []

    def test_players_missing_from_the_adp_board_are_skipped(self):
        """A deep sleeper off the 190-player board can't be priced, so it
        shouldn't appear in an offer rather than being valued at zero."""
        offers = build_offers_for_team(
            "Sharks", self.their_roster, roster(("Undrafted Guy", "WR")),
            self.adp(), self.config, 3
        )
        assert offers == []
