"""Tests for the defensive-matchup read.

The load-bearing one is TestItNeverTouchesTheLineup. Everything else here is
about getting a number right; that class is about the number never being
applied. Yahoo's projection already prices some matchup in, so an adjustment
layered on top double-counts by an unknown amount and silently changes which
nine players start — and the result still looks like a reasonable lineup, so
nobody would catch it. The guarantee is that matchup is reported and never
folded in, and it is worth a test rather than a comment.
"""
from __future__ import annotations

import pytest

from fantasy_manager import matchup
from fantasy_manager.matchup import (
    MIN_GAMES,
    MIN_OBSERVATIONS,
    Observation,
    build_ratings,
    coverage,
    defense_faced,
    load_history,
    rate,
)
from fantasy_manager.weekly import WeeklyPlayer, optimal_lineup

STARTERS = {"QB": 1, "RB": 2, "WR": 2, "TE": 1, "FLEX": 2, "DEF": 1}

WEEK_HEADER = ("name,pos,team,slot,status,opponent,proj,actual,bye,bye_week,"
               "roster_status\n")


def week_file(directory, week: int, rows: list[str]) -> None:
    path = directory / f"week{week:02d}.csv"
    path.write_text(WEEK_HEADER + "".join(r + "\n" for r in rows))


def observations(defense: str, pos: str, points: list[float], start_week: int = 1):
    return [Observation(week=start_week + i, name=f"{pos}{i}", pos=pos,
                        defense=defense, points=p)
            for i, p in enumerate(points)]


class TestDefenseFaced:
    @pytest.mark.parametrize("opponent,expected", [
        ("@CAR", "CAR"),
        ("vs NYJ", "NYJ"),
        ("vs. NYJ", "NYJ"),
        ("@ gb", "GB"),
        (None, None),
        ("", None),
        ("Final W 13-10", None),
    ])
    def test_reads_the_team_on_the_other_side(self, opponent, expected):
        assert defense_faced(opponent) == expected


class TestLoadHistory:
    def test_reads_each_week_file(self, tmp_path, monkeypatch):
        monkeypatch.setattr(matchup.profiles, "profile_dir", lambda *a, **k: str(tmp_path))
        week_file(tmp_path, 1, ["Alpha,RB,DET,RB,,@CAR,12.0,14.5,False,6,"])
        week_file(tmp_path, 2, ["Alpha,RB,DET,RB,,vs GB,11.0,8.25,False,6,"])
        history = load_history()
        assert [(o.week, o.defense, o.points) for o in history] == [
            (1, "CAR", 14.5), (2, "GB", 8.25)]

    def test_skips_the_overwritten_current_file(self, tmp_path, monkeypatch):
        """week_current.csv is rewritten in place every import, so counting it
        would double whichever week happened to be current at the time."""
        monkeypatch.setattr(matchup.profiles, "profile_dir", lambda *a, **k: str(tmp_path))
        week_file(tmp_path, 3, ["Alpha,RB,DET,RB,,@CAR,12.0,14.5,False,6,"])
        (tmp_path / "week_current.csv").write_text(
            WEEK_HEADER + "Alpha,RB,DET,RB,,@CAR,12.0,14.5,False,6,\n")
        assert len(load_history()) == 1

    def test_a_row_with_no_result_is_not_a_zero(self, tmp_path, monkeypatch):
        # Before the game is played there is no result, and "no information" is
        # not "scored nothing" — counting it would mark the defence as tough.
        monkeypatch.setattr(matchup.profiles, "profile_dir", lambda *a, **k: str(tmp_path))
        week_file(tmp_path, 1, ["Alpha,RB,DET,RB,,@CAR,12.0,,False,6,"])
        assert load_history() == []

    def test_an_inactive_player_says_nothing_about_the_defence(self, tmp_path, monkeypatch):
        """A zero from someone who did not play is about his hamstring.

        Counting it would rate every defence that happened to face an injured
        starter as tough, which is exactly backwards.
        """
        monkeypatch.setattr(matchup.profiles, "profile_dir", lambda *a, **k: str(tmp_path))
        week_file(tmp_path, 1, [
            "Out,RB,DET,RB,O,@CAR,12.0,0.0,False,6,",
            "Doubtful,RB,DET,RB,D,@CAR,12.0,0.0,False,6,",
            "OnBye,RB,DET,RB,,@CAR,12.0,0.0,True,6,",
            "Played,RB,DET,RB,,@CAR,12.0,3.5,False,6,",
        ])
        assert [o.name for o in load_history()] == ["Played"]

    def test_a_flagged_player_who_played_still_counts(self, tmp_path, monkeypatch):
        # Questionable means expected to play, and he did.
        monkeypatch.setattr(matchup.profiles, "profile_dir", lambda *a, **k: str(tmp_path))
        week_file(tmp_path, 1, ["Q Guy,RB,DET,RB,Q,@CAR,12.0,15.5,False,6,"])
        assert [o.points for o in load_history()] == [15.5]

    def test_unrated_positions_are_left_out(self, tmp_path, monkeypatch):
        """Kickers and defences score on game script, not on who they face."""
        monkeypatch.setattr(matchup.profiles, "profile_dir", lambda *a, **k: str(tmp_path))
        week_file(tmp_path, 1, [
            "Kicker,K,DET,K,,@CAR,8.0,9.0,False,6,",
            "Defense,DEF,DET,DEF,,@CAR,7.0,11.0,False,6,",
            "Back,RB,DET,RB,,@CAR,12.0,9.0,False,6,",
        ])
        assert [o.pos for o in load_history()] == ["RB"]

    def test_a_row_with_no_opponent_cannot_be_attributed(self, tmp_path, monkeypatch):
        monkeypatch.setattr(matchup.profiles, "profile_dir", lambda *a, **k: str(tmp_path))
        week_file(tmp_path, 1, ["Alpha,RB,DET,RB,,,12.0,14.5,False,6,"])
        assert load_history() == []

    def test_missing_directory_is_empty_not_an_error(self, tmp_path, monkeypatch):
        monkeypatch.setattr(matchup.profiles, "profile_dir",
                            lambda *a, **k: str(tmp_path / "nope"))
        assert load_history() == []


class TestBuildRatings:
    def test_ranks_most_points_allowed_first(self):
        history = (observations("JAX", "RB", [20.0, 22.0, 18.0, 21.0])
                   + observations("DEN", "RB", [4.0, 6.0, 3.0, 5.0]))
        ratings = build_ratings(history)
        assert ratings[("JAX", "RB")].rank == 1     # the matchup you want
        assert ratings[("DEN", "RB")].rank == 2
        assert ratings[("JAX", "RB")].of == 2

    def test_a_thin_sample_is_not_rated(self):
        # Two games is a result, not a pattern, and a confident ranking off it
        # is worse than none because it will be believed.
        assert build_ratings(observations("JAX", "RB", [20.0, 22.0])) == {}

    def test_enough_players_but_not_enough_games_is_not_rated(self):
        # Four observations, all from one week — one game against one offence.
        history = [Observation(week=1, name=f"RB{i}", pos="RB", defense="JAX",
                               points=20.0) for i in range(4)]
        assert build_ratings(history) == {}

    def test_the_thresholds_are_the_documented_ones(self):
        exactly = [Observation(week=w, name=f"RB{i}", pos="RB", defense="JAX",
                               points=10.0)
                   for w in range(1, MIN_GAMES + 1) for i in range(2)]
        assert len({o.week for o in exactly}) == MIN_GAMES
        assert len(exactly) >= MIN_OBSERVATIONS
        assert ("JAX", "RB") in build_ratings(exactly)

    def test_positions_are_ranked_separately(self):
        """Fifteen points means something different for a QB than a tight end.

        One combined table would put every quarterback matchup at the soft end
        and every tight end at the tough end, which says nothing about defences.
        """
        history = (observations("JAX", "QB", [22.0, 24.0, 20.0, 23.0])
                   + observations("DEN", "QB", [18.0, 17.0, 19.0, 18.0])
                   + observations("JAX", "TE", [6.0, 7.0, 5.0, 6.0])
                   + observations("DEN", "TE", [9.0, 10.0, 8.0, 9.0]))
        ratings = build_ratings(history)
        assert ratings[("JAX", "QB")].rank == 1 and ratings[("JAX", "QB")].of == 2
        # DEN allows fewer QB points but more to tight ends — and the ranking
        # reflects that per position rather than averaging it away.
        assert ratings[("DEN", "TE")].rank == 1
        assert ratings[("JAX", "TE")].rank == 2

    def test_ties_break_on_team_so_the_order_is_stable(self):
        history = (observations("AAA", "RB", [10.0] * 4)
                   + observations("ZZZ", "RB", [10.0] * 4))
        first = build_ratings(history)
        second = build_ratings(list(reversed(history)))
        assert first[("AAA", "RB")].rank == 1
        assert first[("AAA", "RB")].rank == second[("AAA", "RB")].rank

    def test_the_mean_is_per_player_not_a_team_total(self):
        # The metric this data can support: what one fantasy-relevant player
        # scored, averaged. Not the league-wide "points allowed to RBs".
        history = observations("JAX", "RB", [10.0, 20.0, 30.0, 40.0])
        assert build_ratings(history)[("JAX", "RB")].points_per_player == 25.0


class TestVerdict:
    def _rating(self, rank, of):
        return matchup.DefenseRating(team="X", pos="RB", games=3, observations=4,
                                     points_per_player=10.0, rank=rank, of=of)

    def test_thirds_of_the_rated_field(self):
        assert self._rating(1, 30).verdict == "soft"
        assert self._rating(10, 30).verdict == "soft"
        assert self._rating(15, 30).verdict == "neutral"
        assert self._rating(20, 30).verdict == "neutral"
        assert self._rating(21, 30).verdict == "tough"
        assert self._rating(30, 30).verdict == "tough"

    def test_too_few_defences_to_compare_says_unrated(self):
        # "Soft compared to one other defence" is not a matchup read.
        assert self._rating(1, 2).verdict == "unrated"

    def test_the_label_names_the_sample_it_rests_on(self):
        label = self._rating(3, 24).label
        assert "3rd-most" in label and "24 rated" in label
        assert "4 players" in label and "3 games" in label

    @pytest.mark.parametrize("n,expected", [
        (1, "1st"), (2, "2nd"), (3, "3rd"), (4, "4th"),
        (11, "11th"), (12, "12th"), (13, "13th"), (21, "21st"), (22, "22nd"),
    ])
    def test_ordinals(self, n, expected):
        assert matchup._ordinal(n) == expected


class TestRate:
    def test_finds_this_weeks_defence_for_a_player(self):
        ratings = build_ratings(observations("CAR", "RB", [20.0, 22.0, 18.0, 21.0]))
        player = WeeklyPlayer(name="Alpha", pos="RB", team="CHI", opponent="@CAR")
        assert rate(player, ratings).team == "CAR"

    def test_an_unrated_defence_is_none_not_a_neutral_guess(self):
        player = WeeklyPlayer(name="Alpha", pos="RB", team="CHI", opponent="@CAR")
        assert rate(player, {}) is None

    def test_a_player_with_no_opponent_has_no_matchup(self):
        ratings = build_ratings(observations("CAR", "RB", [20.0, 22.0, 18.0, 21.0]))
        assert rate(WeeklyPlayer(name="A", pos="RB", team="CHI"), ratings) is None


class TestCoverage:
    def test_no_history_explains_that_it_cannot_be_backfilled(self):
        message = coverage([], {})
        assert "nothing to measure" in message
        assert "backfilled" in message

    def test_some_history_but_no_ratings_names_the_thresholds(self):
        history = observations("JAX", "RB", [20.0, 22.0])
        message = coverage(history, {})
        assert str(MIN_GAMES) in message and str(MIN_OBSERVATIONS) in message

    def test_ratings_carry_the_caveat_with_them(self):
        history = observations("JAX", "RB", [20.0, 22.0, 18.0, 21.0])
        message = coverage(history, build_ratings(history))
        # It is one league's rosters, not the NFL, and says so where it is read.
        assert "your league only" in message
        assert "not league-wide totals" in message


class TestItNeverTouchesTheLineup:
    """The guarantee the whole design rests on.

    If matchup ever starts feeding the optimiser, it double-counts whatever
    Yahoo already priced in, and the damage is invisible: the lineup still
    looks like a lineup. These fail if anyone wires it in.
    """

    def _roster(self):
        return [
            WeeklyPlayer(name="QB1", pos="QB", team="CHI", proj=18.0, opponent="@JAX"),
            WeeklyPlayer(name="RB1", pos="RB", team="NYJ", proj=14.0, opponent="@DEN"),
            WeeklyPlayer(name="RB2", pos="RB", team="LAR", proj=13.9, opponent="vs JAX"),
            WeeklyPlayer(name="WR1", pos="WR", team="SF", proj=12.0, opponent="@DEN"),
            WeeklyPlayer(name="WR2", pos="WR", team="KC", proj=11.0, opponent="vs JAX"),
            WeeklyPlayer(name="TE1", pos="TE", team="ATL", proj=8.0, opponent="@DEN"),
            WeeklyPlayer(name="FLEX1", pos="RB", team="MIA", proj=7.0, opponent="vs JAX"),
            WeeklyPlayer(name="FLEX2", pos="WR", team="BUF", proj=6.0, opponent="@DEN"),
            WeeklyPlayer(name="DEF1", pos="DEF", team="SEA", proj=6.0, opponent="@JAX"),
        ]

    def test_the_optimiser_does_not_import_matchup(self):
        import inspect

        from fantasy_manager import weekly
        source = inspect.getsource(weekly)
        assert "matchup" not in source.replace("matchup.py", ""), (
            "weekly.py must not depend on matchup — the projection is Yahoo's "
            "and already prices some matchup in")

    def test_the_lineup_is_identical_whatever_the_matchups_say(self):
        # RB2 faces the softest defence in the league and RB1 the toughest, by
        # a wide margin. The lineup must still be ordered by Yahoo's number.
        roster = self._roster()
        baseline = optimal_lineup(roster, STARTERS)

        history = (observations("JAX", "RB", [30.0, 32.0, 28.0, 31.0])
                   + observations("DEN", "RB", [1.0, 2.0, 1.5, 1.0])
                   + observations("JAX", "WR", [30.0, 32.0, 28.0, 31.0])
                   + observations("DEN", "WR", [1.0, 2.0, 1.5, 1.0]))
        ratings = build_ratings(history)
        assert ratings, "the fixture should produce real ratings"

        after = optimal_lineup(roster, STARTERS)
        assert ([a.player.name if a.player else None for a in baseline.starters]
                == [a.player.name if a.player else None for a in after.starters])
        assert baseline.projected == after.projected

    def test_ratings_do_not_mutate_the_players_they_describe(self):
        roster = self._roster()
        before = [(p.name, p.proj) for p in roster]
        ratings = build_ratings(observations("DEN", "RB", [1.0, 2.0, 1.5, 1.0]))
        for player in roster:
            rate(player, ratings)
        assert [(p.name, p.proj) for p in roster] == before
