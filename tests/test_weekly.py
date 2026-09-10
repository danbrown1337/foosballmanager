"""Tests for the in-season weekly engine: lineup optimisation, the
current-lineup diff, waiver valuation, and the season calendar.

The optimiser test is the one that matters most: weekly.optimal_lineup claims
greedy fill is exactly optimal for this slot structure, and that claim is
checked against brute-force enumeration on randomised rosters rather than
asserted in a docstring and believed.
"""
import datetime
import itertools
import random

import pytest

from fantasy_manager import weekly
from fantasy_manager.weekly import (
    WeeklyPlayer,
    bye_outlook,
    current_week,
    evaluate_waiver_targets,
    expand_slots,
    lineup_changes,
    optimal_lineup,
    set_lineup,
    slot_accepts,
    waiver_system,
    week_label,
)

STARTERS = {"QB": 1, "RB": 2, "WR": 2, "TE": 1, "FLEX": 2, "DEF": 1}


def player(name, pos, proj=None, **kwargs):
    return WeeklyPlayer(name=name, pos=pos, team=kwargs.pop("team", "FA"),
                        proj=proj, **kwargs)


def brute_force_best(players, starters, superflex=False):
    """Every legal assignment of players to slots, scored. Exponential and
    only usable on tiny rosters — which is the point: it is the ground truth
    the fast path is checked against.

    The None padding matters. A roster with no wide receiver has to be allowed
    to leave the WR slot empty and still fill the rest; without the padding
    every candidate assignment is rejected and the "truth" comes back as zero.
    """
    slots = expand_slots(starters, superflex=superflex)
    eligible = [p for p in players if p.startable]
    best = 0.0
    for combo in itertools.permutations(eligible + [None] * len(slots), len(slots)):
        total, ok = 0.0, True
        for slot, p in zip(slots, combo):
            if p is None:
                continue  # slot left empty, which is always legal
            if not slot_accepts(slot, p.pos):
                ok = False
                break
            total += p.proj or 0.0
        if ok:
            best = max(best, total)
    return best


class TestExpandSlots:
    def test_counts_become_repeats(self):
        assert expand_slots({"QB": 1, "RB": 2}) == ["QB", "RB", "RB"]

    def test_flex_sorts_after_dedicated(self):
        slots = expand_slots({"FLEX": 2, "QB": 1})
        assert slots.index("QB") < slots.index("FLEX")

    def test_absent_position_stays_absent(self):
        # The league this was built for has no kicker. An absent slot must not
        # be invented, the same rule the draft engine follows.
        assert "K" not in expand_slots(STARTERS)

    def test_zero_count_produces_no_slot(self):
        assert expand_slots({"QB": 1, "K": 0}) == ["QB"]

    def test_superflex_upgrades_flex(self):
        assert slot_accepts(expand_slots({"FLEX": 1}, superflex=True)[0], "QB")

    def test_narrower_flex_is_filled_before_a_wider_one(self):
        # Load-bearing, not cosmetic. Fill the superflex first and it takes the
        # only running back, leaving the W/R/T stranded beside a quarterback it
        # cannot use — see test_mixed_flex_does_not_strand_a_slot below.
        slots = expand_slots({"SUPERFLEX": 1, "FLEX": 1})
        assert slots.index("FLEX") < slots.index("SUPERFLEX")


class TestSlotEligibility:
    def test_flex_takes_rb_wr_te_but_not_qb(self):
        assert slot_accepts("FLEX", "RB") and slot_accepts("W/R/T", "TE")
        assert not slot_accepts("FLEX", "QB")
        assert not slot_accepts("FLEX", "DEF")

    def test_dedicated_slot_is_exact(self):
        assert slot_accepts("QB", "QB")
        assert not slot_accepts("RB", "WR")


class TestStartability:
    @pytest.mark.parametrize("status", ["O", "IR", "SUSP", "PUP", "NA"])
    def test_hard_out_is_never_playable(self, status):
        assert not player("X", "RB", 12.0, status=status).playable

    def test_bye_is_never_playable(self):
        assert not player("X", "RB", 12.0, bye=True).playable

    def test_doubtful_is_playable_but_not_startable_by_default(self):
        p = player("X", "RB", 12.0, status="D")
        assert p.playable and not p.startable

    def test_questionable_starts_but_is_flagged(self):
        p = player("X", "RB", 12.0, status="Q")
        assert p.startable and p.flagged


class TestOptimalLineup:
    def test_fills_every_slot(self):
        roster = [player(f"P{i}", pos, float(20 - i)) for i, pos in enumerate(
            ["QB", "RB", "RB", "RB", "WR", "WR", "WR", "TE", "DEF"])]
        best = optimal_lineup(roster, STARTERS)
        assert len(best.starters) == 9
        assert all(a.player for a in best.starters)

    def test_flex_takes_the_best_leftover(self):
        roster = [
            player("QB1", "QB", 20), player("RB1", "RB", 18), player("RB2", "RB", 15),
            player("RB3", "RB", 14), player("WR1", "WR", 17), player("WR2", "WR", 12),
            player("WR3", "WR", 6), player("TE1", "TE", 9), player("DEF1", "DEF", 8),
        ]
        best = optimal_lineup(roster, STARTERS)
        flex = [a.player.name for a in best.starters if a.slot == "FLEX"]
        # WR2 holds a dedicated WR slot, so the leftovers are RB3 and WR3.
        assert sorted(flex) == ["RB3", "WR3"]

    def test_never_starts_a_player_on_bye(self):
        roster = [player("Star", "RB", 25.0, bye=True), player("Sub", "RB", 5.0),
                  player("Other", "RB", 4.0)]
        best = optimal_lineup(roster, {"RB": 2})
        assert "Star" not in best.named()

    def test_never_starts_an_out_player(self):
        roster = [player("Hurt", "RB", 25.0, status="O"), player("Fit", "RB", 5.0)]
        best = optimal_lineup(roster, {"RB": 1})
        assert best.named() == {"Fit"}

    def test_doubtful_excluded_by_default_but_admitted_on_request(self):
        roster = [player("Iffy", "RB", 20.0, status="D"), player("Fit", "RB", 5.0)]
        assert optimal_lineup(roster, {"RB": 1}).named() == {"Fit"}
        assert optimal_lineup(roster, {"RB": 1}, allow_doubtful=True).named() == {"Iffy"}

    def test_empty_slot_is_reported_not_hidden(self):
        best = optimal_lineup([player("QB1", "QB", 20)], {"QB": 1, "DEF": 1})
        empty = [a for a in best.starters if a.player is None]
        assert len(empty) == 1 and empty[0].slot == "DEF"
        assert empty[0].empty_reason

    def test_warns_when_a_starter_has_no_projection(self):
        roster = [player("NoProj", "QB", None)]
        best = optimal_lineup(roster, {"QB": 1})
        assert any("No weekly projection" in w for w in best.warnings)

    def test_unprojected_player_sorts_below_a_projected_one(self):
        # "No information" must not be treated as "projected zero" in either
        # direction: the known quantity starts, but the unknown isn't buried
        # beneath a player projected to score nothing.
        roster = [player("Known", "RB", 8.0), player("Unknown", "RB", None)]
        assert optimal_lineup(roster, {"RB": 1}).named() == {"Known"}

    def test_warns_when_a_hurt_player_occupies_a_starting_slot(self):
        roster = [player("Hurt", "RB", 20.0, status="O", slot="RB"),
                  player("Fit", "RB", 5.0, slot="BN")]
        best = optimal_lineup(roster, {"RB": 1})
        assert any("scores 0" in w for w in best.warnings)

    @pytest.mark.parametrize("seed", range(40))
    def test_greedy_matches_brute_force(self, seed):
        """The optimality claim in optimal_lineup's docstring, checked."""
        rng = random.Random(seed)
        positions = ["QB", "RB", "WR", "TE", "DEF"]
        roster = [
            player(f"P{i}", rng.choice(positions), round(rng.uniform(0, 25), 2))
            for i in range(rng.randint(6, 9))
        ]
        starters = {"QB": 1, "RB": 1, "WR": 1, "FLEX": 1}
        assert optimal_lineup(roster, starters).projected == pytest.approx(
            brute_force_best(roster, starters))

    def test_mixed_flex_does_not_strand_a_slot(self):
        """A league running both a W/R/T and a superflex.

        Greedy by raw projection would hand the superflex the running back
        (the best player left) and leave the W/R/T empty, scoring 20 instead
        of 38. Filling the narrower slot first is what avoids it.
        """
        roster = [player("RB3", "RB", 20.0), player("QB2", "QB", 18.0)]
        # Written superflex-first on purpose: config order must not decide the
        # answer, so this fails if the fill order comes from the dict rather
        # than from how restrictive each slot is.
        starters = {"SUPERFLEX": 1, "FLEX": 1}
        best = optimal_lineup(roster, starters)
        assert best.projected == pytest.approx(38.0)
        assert best.projected == pytest.approx(brute_force_best(roster, starters))

    @pytest.mark.parametrize("seed", range(20))
    def test_greedy_matches_brute_force_with_mixed_flex(self, seed):
        rng = random.Random(5000 + seed)
        roster = [
            player(f"P{i}", rng.choice(["QB", "RB", "WR", "TE"]),
                   round(rng.uniform(0, 25), 2))
            for i in range(rng.randint(3, 7))
        ]
        starters = {"QB": 1, "FLEX": 1, "SUPERFLEX": 1}
        assert optimal_lineup(roster, starters).projected == pytest.approx(
            brute_force_best(roster, starters))

    @pytest.mark.parametrize("seed", range(15))
    def test_greedy_matches_brute_force_with_superflex(self, seed):
        rng = random.Random(1000 + seed)
        roster = [
            player(f"P{i}", rng.choice(["QB", "RB", "WR", "TE"]),
                   round(rng.uniform(0, 25), 2))
            for i in range(rng.randint(5, 8))
        ]
        starters = {"QB": 1, "RB": 1, "FLEX": 1}
        assert optimal_lineup(roster, starters, superflex=True).projected == pytest.approx(
            brute_force_best(roster, starters, superflex=True))


class TestSetLineup:
    """What Yahoo has set, as opposed to what it should be.

    Its total is the only end-to-end check on the parser that exists: it should
    equal the projected total Yahoo displays on the same page. That number is
    not in the page text, so the comparison is the reader's — which is exactly
    why the sum has to be right.
    """

    def test_reads_the_slots_the_page_reported(self):
        players = [
            player("Starter", "QB", 20.0, slot="QB"),
            player("Flexed", "RB", 10.0, slot="W/R/T"),
            player("Benched", "RB", 30.0, slot="BN"),
            player("Stashed", "WR", 25.0, slot="IR"),
        ]
        result = set_lineup(players)
        assert [p.name for p in result.players] == ["Starter", "Flexed"]
        assert result.projected == 30.0

    def test_a_starter_without_a_projection_is_named_not_zeroed_silently(self):
        # A total quietly missing a player looks exactly like one that works.
        players = [player("Known", "QB", 20.0, slot="QB"),
                   player("Unknown", "RB", None, slot="RB")]
        result = set_lineup(players)
        assert result.projected == 20.0
        assert result.unprojected == ["Unknown"]

    def test_rows_with_no_slot_are_not_a_lineup(self):
        # The available-players page carries no slot column at all.
        assert set_lineup([player("Wire", "RB", 12.0)]).players == []

    def test_matches_yahoos_own_displayed_total_on_the_captured_page(self):
        import os
        from fantasy_manager.browser_sync import parse_weekly_text
        path = os.path.join(os.path.dirname(__file__), "fixtures",
                            "yahoo_myteam_week1.txt")
        with open(path) as f:
            roster = [WeeklyPlayer(**row) for row in parse_weekly_text(f.read())]
        result = set_lineup(roster)
        # Yahoo displayed 120.96 for the lineup it had set on this page.
        assert len(result.players) == 9
        assert result.projected == 120.96
        assert result.unprojected == []


class TestLineupChanges:
    def test_no_changes_when_yahoo_already_optimal(self):
        roster = [player("QB1", "QB", 20, slot="QB"), player("Bench", "QB", 5, slot="BN")]
        best = optimal_lineup(roster, {"QB": 1})
        assert lineup_changes(roster, best) == []

    def test_swap_is_reported_with_the_gain(self):
        roster = [player("Weak", "RB", 5.0, slot="RB"), player("Strong", "RB", 15.0, slot="BN")]
        best = optimal_lineup(roster, {"RB": 1})
        changes = lineup_changes(roster, best)
        assert len(changes) == 1
        assert changes[0].start_player.name == "Strong"
        assert changes[0].bench_player.name == "Weak"
        assert changes[0].gain == pytest.approx(10.0)

    def test_injured_starter_is_called_out_by_status(self):
        roster = [player("Hurt", "RB", 20.0, status="O", slot="RB"),
                  player("Fit", "RB", 5.0, slot="BN")]
        changes = lineup_changes(roster, optimal_lineup(roster, {"RB": 1}))
        assert "O" in changes[0].reason

    def test_a_starter_who_changes_slot_is_told_to_move(self):
        """Nobody is benched here, so the swap logic alone stays silent — and
        a tight end left sitting in a flex spot means the TE slot scores zero.
        """
        roster = [
            player("TE1", "TE", 12.0, slot="W/R/T"),
            player("RB1", "RB", 15.0, slot="BN"),
        ]
        best = optimal_lineup(roster, {"TE": 1, "FLEX": 1})
        moves = [c for c in lineup_changes(roster, best) if c.move_only]
        assert len(moves) == 1
        assert moves[0].start_player.name == "TE1"
        assert moves[0].slot == "TE"

    def test_flex_aliases_are_not_reported_as_a_move(self):
        # Yahoo says "W/R/T", the config template says "FLEX". Same slot.
        roster = [player("RB1", "RB", 10.0, slot="W/R/T")]
        best = optimal_lineup(roster, {"FLEX": 1})
        assert [c for c in lineup_changes(roster, best) if c.move_only] == []

    def test_swap_pairs_a_slot_the_incoming_player_can_fill(self):
        roster = [
            player("QB1", "QB", 18, slot="QB"),
            player("BadRB", "RB", 2.0, slot="RB"),
            player("GoodRB", "RB", 16.0, slot="BN"),
        ]
        changes = lineup_changes(roster, optimal_lineup(roster, {"QB": 1, "RB": 1}))
        assert len(changes) == 1
        # It must not propose benching the QB to start a running back.
        assert changes[0].bench_player.name == "BadRB"


class TestWaiverTargets:
    def _roster(self):
        """Nine startable players for nine slots, plus one bench body.

        The sizing is deliberate: leave a slot unfilled and every position's
        replacement level collapses to zero, which is correct behaviour but
        tests something other than what these cases are about.
        """
        return [
            player("QB1", "QB", 18.0), player("RB1", "RB", 14.0), player("RB2", "RB", 4.0),
            player("WR1", "WR", 13.0), player("WR2", "WR", 11.0), player("WR3", "WR", 9.0),
            player("TE1", "TE", 7.0), player("DEF1", "DEF", 6.0),
            player("FlexRB", "RB", 8.0), player("Scrub", "WR", 1.0),
        ]

    def test_ranks_by_gain_over_who_they_would_replace(self):
        available = [player("Big", "RB", 16.0), player("Small", "RB", 5.0)]
        targets = evaluate_waiver_targets(available, self._roster(), STARTERS, top=5)
        assert targets[0].player.name == "Big"
        assert targets[0].gain > targets[1].gain

    def test_a_player_who_would_sit_is_marked_depth_only(self):
        available = [player("Backup", "QB", 3.0)]
        targets = evaluate_waiver_targets(available, self._roster(), STARTERS, top=5)
        assert "sit behind" in targets[0].rationale

    def test_empty_slot_makes_replacement_level_zero(self):
        roster = [player("QB1", "QB", 18.0)]
        targets = evaluate_waiver_targets(
            [player("AnyDef", "DEF", 6.0)], roster, {"QB": 1, "DEF": 1}, top=3)
        assert targets[0].gain == pytest.approx(6.0)
        assert "empty" in targets[0].rationale

    def test_faab_bid_scales_with_remaining_budget(self):
        available = [player("Big", "RB", 25.0)]
        cheap = evaluate_waiver_targets(available, self._roster(), STARTERS, faab_remaining=10)
        rich = evaluate_waiver_targets(available, self._roster(), STARTERS, faab_remaining=100)
        assert rich[0].bid_low > cheap[0].bid_low

    def test_no_bid_computed_without_a_budget(self):
        targets = evaluate_waiver_targets(
            [player("Big", "RB", 25.0)], self._roster(), STARTERS, faab_remaining=None)
        assert targets[0].bid_low is None

    def test_marginal_pickup_is_not_worth_burning_priority(self):
        targets = evaluate_waiver_targets(
            [player("Meh", "RB", 4.5)], self._roster(), STARTERS, top=3)
        assert targets[0].worth_priority is False

    def test_unavailable_players_are_skipped(self):
        targets = evaluate_waiver_targets(
            [player("Hurt", "RB", 30.0, status="IR")], self._roster(), STARTERS)
        assert targets == []

    def test_suggests_a_drop_from_the_bench_not_a_starter(self):
        targets = evaluate_waiver_targets(
            [player("Big", "RB", 20.0)], self._roster(), STARTERS, top=1)
        assert targets[0].drop is not None
        assert targets[0].drop.name == "Scrub"

    def test_unrankable_candidates_keep_the_order_they_arrived_in(self):
        """Regression: the tiebreaker used to be the player's name.

        With no weekly projections every gain is None, so that fell all the way
        through to alphabetical — throwing away the ADP ordering the pool was
        handed in and ranking the entire waiver wire by first name.
        """
        pool = [player("Zeta", "RB", None), player("Alpha", "RB", None),
                player("Mid", "RB", None)]
        targets = evaluate_waiver_targets(pool, self._roster(), STARTERS, top=3)
        assert [t.player.name for t in targets] == ["Zeta", "Alpha", "Mid"]

    def test_missing_projection_declines_to_rank(self):
        targets = evaluate_waiver_targets(
            [player("Unknown", "RB", None)], self._roster(), STARTERS, top=3)
        assert targets[0].gain is None
        assert "yourself" in targets[0].rationale

    def test_a_downgrade_is_still_listed_as_depth(self):
        """The empty-list message depends on this.

        Both the CLI and the extension panel say, when nothing comes back,
        that the pool holds nobody who can play. That is only true because a
        pickup who would be *worse* than the incumbent is still returned —
        ranked last, with a negative gain and a "depth only" rationale. If
        this ever started filtering on gain, both messages would quietly
        become lies about why the list was empty.
        """
        targets = evaluate_waiver_targets(
            [player("Worse", "RB", 0.5)], self._roster(), STARTERS, top=3)
        assert [t.player.name for t in targets] == ["Worse"]
        assert targets[0].gain < 0
        assert "depth only" in targets[0].rationale

    def test_empty_only_when_nobody_in_the_pool_can_play(self):
        pool = [player("Shelved", "RB", 30.0, status="IR"),
                player("Resting", "WR", 30.0, bye=True),
                player("Sidelined", "TE", 30.0, status="O")]
        assert evaluate_waiver_targets(pool, self._roster(), STARTERS, top=5) == []
        assert evaluate_waiver_targets([], self._roster(), STARTERS, top=5) == []


class TestCurrentWeek:
    def test_derives_week_from_kickoff(self):
        config = {"season": {"week1_start": "2026-09-10"}}
        assert current_week(config, datetime.date(2026, 9, 10)) == 1
        assert current_week(config, datetime.date(2026, 9, 16)) == 1
        assert current_week(config, datetime.date(2026, 9, 17)) == 2

    def test_none_before_the_season_starts(self):
        config = {"season": {"week1_start": "2026-09-10"}}
        assert current_week(config, datetime.date(2026, 8, 1)) is None

    def test_none_rather_than_a_guess_when_unconfigured(self):
        assert current_week({}, datetime.date(2026, 10, 1)) is None
        assert current_week({"season": {"week1_start": "nonsense"}}) is None

    def test_accepts_a_date_object_from_yaml(self):
        config = {"season": {"week1_start": datetime.date(2026, 9, 10)}}
        assert current_week(config, datetime.date(2026, 9, 24)) == 3

    def test_caps_at_week_18(self):
        config = {"season": {"week1_start": "2026-09-10"}}
        assert current_week(config, datetime.date(2027, 6, 1)) == 18


class TestRosterStatus:
    """Only the available-players page carries this, and it decides the action:
    a free agent is first-come, a waiver player needs a claim before the run."""

    def test_free_agent(self):
        p = player("X", "RB", 10.0, roster_status="FA")
        assert p.is_free_agent and p.waiver_clears is None

    def test_on_waivers_reports_when_it_clears(self):
        p = player("X", "RB", 10.0, roster_status="W (Sep 11)")
        assert not p.is_free_agent
        assert p.waiver_clears == "Sep 11"

    def test_absent_on_my_team_rows(self):
        p = player("X", "RB", 10.0)
        assert not p.is_free_agent and p.waiver_clears is None


class TestWeekLabel:
    """Two different "no current week" states that must not read the same:
    one is a date to wait for, the other is a line of YAML to go and fill in."""

    def test_in_season(self):
        config = {"season": {"week1_start": "2026-09-10"}}
        assert week_label(config, datetime.date(2026, 10, 1)) == "Week 4"

    def test_before_kickoff_names_the_date(self):
        config = {"season": {"week1_start": "2026-09-10"}}
        label = week_label(config, datetime.date(2026, 9, 1))
        assert "Preseason" in label and "2026-09-10" in label

    def test_unconfigured_is_distinct_from_preseason(self):
        assert week_label({}, datetime.date(2026, 10, 1)) == "Week unknown"


class TestWaiverSystem:
    def test_defaults_to_faab(self):
        assert waiver_system({})[0] == "faab"

    def test_reads_priority(self):
        assert waiver_system({"waivers": {"system": "priority"}})[0] == "priority"

    def test_unknown_system_falls_back_to_faab(self):
        assert waiver_system({"waivers": {"system": "auction-ish"}})[0] == "faab"

    def test_remaining_falls_back_to_budget(self):
        assert waiver_system({"waivers": {"faab_budget": 200}})[1] == 200

    def test_remaining_wins_over_budget(self):
        assert waiver_system({"waivers": {"faab_budget": 200, "faab_remaining": 37}})[1] == 37


class TestByeOutlook:
    def test_flags_a_week_that_leaves_a_slot_short(self):
        roster = [player("QB1", "QB", team="KC"), player("RB1", "RB", team="DET"),
                  player("RB2", "RB", team="DET")]
        byes = {"KC": 5, "DET": 6}
        out = bye_outlook(roster, byes, week=5, starters={"QB": 1, "RB": 2}, weeks_ahead=2)
        assert out and out[0][0] == 6

    def test_quiet_when_depth_covers_the_bye(self):
        roster = [player("RB1", "RB", team="DET"), player("RB2", "RB", team="KC"),
                  player("RB3", "RB", team="SF")]
        byes = {"DET": 6, "KC": 5, "SF": 8}
        assert bye_outlook(roster, byes, week=5, starters={"RB": 2}, weeks_ahead=2) == []

    def test_returns_nothing_without_a_known_week(self):
        assert bye_outlook([player("X", "RB", team="KC")], {"KC": 5}, None, {"RB": 1}) == []


class TestKickerLeagueEndToEnd:
    """The engine over a page containing a kicker, an IR player, a bye, and a
    starter ruled Out — shapes the week-1 capture did not contain.

    That fixture is CONSTRUCTED, not captured: it follows the row layout the
    real week-1 page established, extended to rows that page happened not to
    have. So it pins the engine's handling of those shapes, and it does not
    prove Yahoo renders them this way. The week-1 fixture is the real one.

    tests/test_browser_sync.py pins the parse; this pins what the engine does
    with it, because a correctly parsed Out player still has to be kept out of
    the lineup.
    """
    STARTERS = {"QB": 1, "RB": 2, "WR": 2, "TE": 1, "FLEX": 1, "K": 1, "DEF": 1}

    @pytest.fixture
    def roster(self):
        import pathlib
        from fantasy_manager.browser_sync import parse_weekly_text
        text = (pathlib.Path(__file__).parent / "fixtures"
                / "yahoo_myteam_week5_kicker.txt").read_text()
        return [WeeklyPlayer(**row) for row in parse_weekly_text(text)]

    def test_the_whole_lineup(self, roster):
        best = optimal_lineup(roster, self.STARTERS)
        assert best.named() == {
            "Josh Allen", "Kenneth Walker III", "Tyler Allgeier", "Ja'Marr Chase",
            "Jaylen Waddle", "Taysom Hill", "Harrison Butker", "Ravens",
            "Rome Odunze",
        }
        assert best.projected == pytest.approx(109.30)

    def test_the_kicker_slot_is_filled(self, roster):
        best = optimal_lineup(roster, self.STARTERS)
        kicker = [a for a in best.starters if a.slot == "K"]
        assert len(kicker) == 1 and kicker[0].player.name == "Harrison Butker"

    def test_a_league_with_no_kicker_slot_never_starts_one(self, roster):
        # The engine treats an absent position as "never," not "assume one" —
        # the same rule the draft side follows.
        no_kicker = dict(self.STARTERS)
        del no_kicker["K"]
        assert "Harrison Butker" not in optimal_lineup(roster, no_kicker).named()

    def test_out_and_bye_starters_are_benched_and_warned(self, roster):
        best = optimal_lineup(roster, self.STARTERS)
        assert "Bijan Robinson" not in best.named()   # ruled Out
        assert "Nico Collins" not in best.named()     # on bye
        warnings = " ".join(best.warnings)
        assert "Bijan Robinson" in warnings and "Nico Collins" in warnings

    def test_ir_player_in_the_ir_slot_is_not_warned_about(self, roster):
        # He is excluded, but an IR player parked in the IR slot is correct —
        # warning about it every week would train the reader to ignore warnings.
        best = optimal_lineup(roster, self.STARTERS)
        assert "Puka Nacua" not in best.named()
        assert "Puka Nacua" not in " ".join(best.warnings)

    def test_questionable_starter_is_started_and_flagged(self, roster):
        best = optimal_lineup(roster, self.STARTERS)
        walker = next(a.player for a in best.starters
                      if a.player and a.player.name == "Kenneth Walker III")
        assert walker.flagged and walker.status_label == "Q"

    def test_bye_outlook_uses_the_page_not_the_shipped_table(self, roster):
        """The page carries each player's bye week, so a stale table must not win.

        bye_weeks.py is a hand-maintained snapshot; the page is authoritative and
        current. Passing a deliberately wrong table proves which one is used.
        """
        wrong_table = {"BUF": 99, "BAL": 99, "ATL": 99}
        weeks = [w for w, _ in bye_outlook(roster, wrong_table, week=5,
                                           starters=self.STARTERS, weeks_ahead=3)]
        assert weeks == [6, 7, 8]   # Ravens (6), Josh Allen (7), the Falcons (8)

    def test_bye_outlook_falls_back_to_the_table_without_page_data(self):
        stripped = [player("QB1", "QB", 20.0, team="KC")]
        out = bye_outlook(stripped, {"KC": 6}, week=5, starters={"QB": 1}, weeks_ahead=2)
        assert [w for w, _ in out] == [6]
