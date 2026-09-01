"""Tests for the full-autopilot pick engine — scoring (risk tolerance and
strategy bias) and the four guardrails that keep "best player available"
from doing something indefensible."""
from fantasy_manager.autopilot import STRATEGY_TAPER_PICKS, auto_pick, score_players

from conftest import make_config, make_player


class TestRiskTolerance:
    def test_safe_floor_amplifies_bust_penalties(self):
        players = [make_player("Risky", "RB", 10.0, adjustment=20.0)]
        safe = score_players(players, make_config(risk="safe_floor"), 0)
        balanced = score_players(players, make_config(risk="balanced"), 0)
        assert safe["Risky"] > balanced["Risky"]

    def test_chase_upside_amplifies_breakout_bonuses(self):
        players = [make_player("Sleeper", "WR", 100.0, adjustment=-10.0)]
        chase = score_players(players, make_config(risk="chase_upside"), 0)
        balanced = score_players(players, make_config(risk="balanced"), 0)
        assert chase["Sleeper"] < balanced["Sleeper"]

    def test_safe_floor_discounts_breakout_upside(self):
        """A floor-seeker only half-believes the breakout case."""
        players = [make_player("Sleeper", "WR", 100.0, adjustment=-10.0)]
        safe = score_players(players, make_config(risk="safe_floor"), 0)
        assert safe["Sleeper"] == 95.0

    def test_balanced_is_a_passthrough(self):
        players = [make_player("Plain", "TE", 40.0)]
        assert score_players(players, make_config(), 0)["Plain"] == 40.0

    def test_unknown_risk_setting_falls_back_to_balanced(self):
        players = [make_player("Risky", "RB", 10.0, adjustment=20.0)]
        scores = score_players(players, make_config(risk="nonsense"), 0)
        assert scores["Risky"] == 30.0


class TestStrategyBias:
    def test_robust_rb_pulls_backs_earlier(self):
        players = [make_player("Back", "RB", 30.0)]
        biased = score_players(players, make_config(strategy="robust_rb"), 0)
        assert biased["Back"] < 30.0

    def test_zero_rb_pushes_backs_later_and_pulls_receivers(self):
        players = [make_player("Back", "RB", 30.0), make_player("Wide", "WR", 30.0)]
        scores = score_players(players, make_config(strategy="zero_rb"), 0)
        assert scores["Back"] > 30.0
        assert scores["Wide"] < 30.0

    def test_bias_tapers_to_nothing_late(self):
        players = [make_player("Back", "RB", 30.0)]
        early = score_players(players, make_config(strategy="robust_rb"), 0)
        late = score_players(players, make_config(strategy="robust_rb"), STRATEGY_TAPER_PICKS - 1)
        assert early["Back"] < late["Back"] < 30.0

    def test_bias_is_gone_past_the_taper(self):
        players = [make_player("Back", "RB", 30.0)]
        scores = score_players(players, make_config(strategy="robust_rb"), STRATEGY_TAPER_PICKS)
        assert scores["Back"] == 30.0

    def test_bpa_never_biases(self):
        players = [make_player("Back", "RB", 30.0)]
        assert score_players(players, make_config(), 0)["Back"] == 30.0


class TestAutoPickBasics:
    def test_returns_none_on_an_exhausted_board(self, config):
        players = [make_player("Gone", "RB", 1.0, drafted_by="rival")]
        assert auto_pick(players, config) is None

    def test_takes_the_best_adjusted_value(self, config):
        """The bust adjustment, not raw ADP, decides — that's the whole point
        of layering research on top of the market."""
        players = [
            make_player("Overpriced", "RB", 1.0, adjustment=30.0),
            make_player("Solid", "WR", 5.0),
        ]
        assert auto_pick(players, config).player.name == "Solid"

    def test_surfaces_the_research_note_as_reasoning(self, config):
        players = [make_player("Sleeper", "WR", 20.0, adjustment=-5.0,
                               note_tag="breakout", note="Clear path to volume")]
        decision = auto_pick(players, config)
        assert "breakout" in decision.reason
        assert "Clear path to volume" in decision.reason

    def test_already_drafted_players_are_never_picked(self, config):
        players = [
            make_player("Taken", "RB", 1.0, drafted_by="rival"),
            make_player("Free", "RB", 50.0),
        ]
        assert auto_pick(players, config).player.name == "Free"


class TestGuardrailKickerDefense:
    def test_no_kicker_or_defense_before_the_starters_are_filled(self):
        config = make_config(starters={"QB": 1, "RB": 1, "K": 1, "DEF": 1})
        players = [
            make_player("Cheap Kicker", "K", 1.0),     # best by ADP, and a trap
            make_player("Real Back", "RB", 50.0),
        ]
        assert auto_pick(players, config).player.name == "Real Back"

    def test_kicker_allowed_once_the_draft_is_late_enough(self):
        """Deep into the draft the K/DEF block lifts even with starting spots
        still open. The drafted players here are WRs so that no *core* need is
        at its replacement cliff, which would otherwise take priority."""
        config = make_config(starters={"QB": 1, "RB": 1, "K": 1, "DEF": 1}, num_teams=10)
        # 30 picks in a 10-team league = round 3, reaching (4 starters - 1).
        players = [make_player(f"Gone{i}", "WR", 10.0 + i, drafted_by="rival") for i in range(30)]
        players += [make_player("Cheap Kicker", "K", 1.0), make_player("Late Back", "RB", 200.0)]
        assert auto_pick(players, config).player.name == "Cheap Kicker"

    def test_kicker_allowed_once_every_core_starter_is_filled(self):
        config = make_config(starters={"QB": 1, "RB": 1, "K": 1, "DEF": 1}, num_teams=10)
        mine = [
            make_player("My QB", "QB", 40.0, drafted_by="mine"),
            make_player("My Back", "RB", 20.0, drafted_by="mine"),
        ]
        players = mine + [make_player("Cheap Kicker", "K", 1.0),
                          make_player("Spare Back", "RB", 200.0)]
        assert auto_pick(players, config).player.name == "Cheap Kicker"


class TestGuardrailBenchCap:
    def test_stops_hoarding_one_position(self):
        config = make_config(starters={"RB": 1, "WR": 1}, bench=6, max_bench_per_pos=1)
        mine = [make_player(f"Mine{i}", "RB", 10.0 + i, drafted_by="mine") for i in range(2)]
        players = mine + [
            make_player("Another Back", "RB", 1.0),   # best available, but capped out
            make_player("Any Receiver", "WR", 80.0),
        ]
        assert auto_pick(players, config).player.name == "Any Receiver"

    def test_fails_open_rather_than_returning_nothing(self):
        """If the guardrails filter away every candidate, still return a pick."""
        config = make_config(starters={"RB": 1}, bench=0, max_bench_per_pos=0)
        mine = [make_player("Mine", "RB", 10.0, drafted_by="mine")]
        players = mine + [make_player("Only Option", "RB", 1.0)]
        assert auto_pick(players, config).player.name == "Only Option"


class TestGuardrailRosterCompletion:
    def test_last_picks_must_fill_empty_starter_slots(self):
        """With exactly as many picks left as unfilled starting spots, BPA is
        no longer allowed to punt — otherwise you reach Week 1 short."""
        config = make_config(starters={"RB": 1, "K": 1}, bench=0, ir=0)
        mine = [make_player("My Back", "RB", 5.0, drafted_by="mine")]
        players = mine + [
            make_player("Stud Back", "RB", 1.0),     # far better value
            make_player("Some Kicker", "K", 150.0),  # but K is the empty slot
        ]
        decision = auto_pick(players, config)
        assert decision.player.name == "Some Kicker"
        assert decision.need_override is True
        assert "Roster-completion override" in decision.reason

    def test_ir_slot_does_not_delay_the_override(self):
        """IR is filled from waivers, not drafted. Counting it as a draftable
        spot used to push this override one pick past the end of the draft,
        so the final pick took a bench flier and left a starter slot empty."""
        config = make_config(
            starters={"QB": 1, "RB": 2, "WR": 2, "TE": 1, "FLEX": 1, "K": 1, "DEF": 1},
            bench=6, ir=1,
        )
        # 14 of 15 picks made; every starter filled except DEF, one pick left.
        mine = (
            [make_player("My QB", "QB", 10.0, drafted_by="mine")]
            + [make_player(f"My RB{i}", "RB", 10.0, drafted_by="mine") for i in range(4)]
            + [make_player(f"My WR{i}", "WR", 10.0, drafted_by="mine") for i in range(5)]
            + [make_player(f"My TE{i}", "TE", 10.0, drafted_by="mine") for i in range(2)]
            + [make_player("My K", "K", 140.0, drafted_by="mine")]
            + [make_player("My Bench", "WR", 150.0, drafted_by="mine")]
        )
        assert len(mine) == 14
        players = mine + [
            # A TE, not a WR: at 6 WRs the bench cap would already block a
            # receiver, which would mask what this test is actually checking.
            make_player("Shiny Bench TE", "TE", 60.0),   # better value, wrong answer
            make_player("Needed Defense", "DEF", 130.0),
        ]
        decision = auto_pick(players, config)
        assert decision.player.name == "Needed Defense"
        assert decision.need_override is True
        assert "Roster-completion override" in decision.reason

    def test_no_override_while_picks_remain(self):
        config = make_config(starters={"RB": 1, "K": 1}, bench=6, ir=0)
        players = [make_player("Stud Back", "RB", 1.0), make_player("Some Kicker", "K", 150.0)]
        decision = auto_pick(players, config)
        assert decision.need_override is False
        assert decision.player.name == "Stud Back"


class TestGuardrailReplacementCliff:
    def test_forces_a_need_pick_at_the_cliff(self):
        """WR is nearly exhausted league-wide and we have none — take the last
        startable one even though a better back is on the board."""
        config = make_config(starters={"RB": 1, "WR": 1}, bench=6, ir=0, num_teams=10)
        drafted = [make_player(f"Gone WR{i}", "WR", 10.0 + i, drafted_by="rival") for i in range(8)]
        players = drafted + [
            make_player("Stud Back", "RB", 1.0),
            make_player("Last Receiver", "WR", 90.0),
        ]
        decision = auto_pick(players, config)
        assert decision.player.name == "Last Receiver"
        assert decision.need_override is True
        assert "replacement cliff" in decision.reason

    def test_no_override_when_the_position_is_deep(self):
        config = make_config(starters={"RB": 1, "WR": 1}, bench=6, ir=0, num_teams=10)
        players = [
            make_player("Stud Back", "RB", 1.0),
            make_player("Some Receiver", "WR", 90.0),
        ]
        decision = auto_pick(players, config)
        assert decision.player.name == "Stud Back"
        assert decision.need_override is False
