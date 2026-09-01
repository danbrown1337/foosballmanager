"""Shared fixtures: small hand-built boards and league configs so the
engine tests don't depend on the shipped 2026 data staying frozen."""
import pytest

from fantasy_manager.board import Player


def make_player(name, pos, adp, rank=1, team="FA", **kwargs):
    return Player(rank=rank, name=name, team=team, pos=pos, adp=adp, **kwargs)


def make_config(
    starters=None,
    num_teams=10,
    bench=6,
    ir=0,
    strategy="best_player_available",
    risk="balanced",
    max_bench_per_pos=3,
):
    return {
        "league": {"num_teams": num_teams, "scoring": "ppr"},
        "roster": {
            "starters": starters or {"QB": 1, "RB": 2, "WR": 2, "TE": 1, "FLEX": 1, "K": 1, "DEF": 1},
            "bench": bench,
            "ir": ir,
        },
        "autopilot": {
            "strategy": strategy,
            "risk_tolerance": risk,
            "max_bench_per_pos": max_bench_per_pos,
        },
    }


@pytest.fixture
def config():
    return make_config()


@pytest.fixture
def adp_csv(tmp_path):
    """Writes an ADP csv and returns its path. Includes the aliased position
    labels (PK/DST) the real source data uses."""
    path = tmp_path / "adp.csv"
    path.write_text(
        "rank,name,team,pos,adp\n"
        "1,Alpha Back,DET,RB,1.5\n"
        "2,Beta Wide,LAR,WR,2.0\n"
        "3,Gamma Back,ATL,RB,12.0\n"
        "4,Delta Tight,ARI,TE,30.0\n"
        "5,Epsilon Kick,DAL,PK,120.0\n"
        "6,Zeta Defense,SEA,DST,130.0\n"
    )
    return str(path)


@pytest.fixture
def notes_csv(tmp_path):
    path = tmp_path / "notes.csv"
    path.write_text(
        "name,tag,adjustment,note\n"
        "Alpha Back,bust,20,Injury risk and a real committee behind him\n"
        "Beta Wide,breakout,8,Clear path to target volume after a departure\n"
    )
    return str(path)
