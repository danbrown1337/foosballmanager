"""
Two players the draft room writes identically need something else to tell them
apart.

Yahoo abbreviates: "B. ROBINSON (RB · ATL)". First initial, surname, position
and team are every discriminator the text offers, and Bijan Robinson and Brian
Robinson Jr. match on all four — both are Atlanta running backs, a hundred and
fifty ADP places apart. Yahoo drops the suffix too, so the room really does
print the same string for both.

That is not a data error to be corrected. It is true, and it cost a
second-round pick more than once while the panel hunted for a naming rule that
cannot exist. The markup was never ambiguous: each row carries data-id, and
Yahoo says Bijan is 40055 and Brian is 34054.

So the rule is not "no collisions" — it is that every colliding pair carries a
Yahoo id. The extension's boardIdentity test enforces the same thing on the
shipped JSON, and its DOM layer is what consumes the ids.
"""
from __future__ import annotations

import collections
import csv
import os

from fantasy_manager.board import ROOT, load_players

SUFFIXES = {"jr", "sr", "ii", "iii", "iv", "v"}


def room_form(name: str) -> str:
    parts = name.replace(".", " ").split()
    if len(parts) < 2:
        return name.lower()
    rest = [w for w in parts[1:] if w.lower() not in SUFFIXES]
    if not rest:
        return name.lower()
    return f"{parts[0][0]}.{' '.join(rest)}".lower()


def yahoo_ids() -> dict[str, str]:
    path = os.path.join(ROOT, "data", "yahoo_ids.csv")
    if not os.path.exists(path):
        return {}
    with open(path) as f:
        return {r["name"]: r["yahoo_id"].strip() for r in csv.DictReader(f)}


def test_indistinguishable_players_carry_a_yahoo_id():
    ids = yahoo_ids()
    groups = collections.defaultdict(list)
    for p in load_players():
        groups[(room_form(p.name), p.pos, p.team)].append(p.name)
    for key, names in groups.items():
        if len(names) < 2:
            continue
        for name in names:
            assert ids.get(name), (
                f"{names} are identical in the room {key} and {name} has no "
                "Yahoo id — nothing can tell them apart at a turn"
            )
        assert len({ids[n] for n in names}) == len(names), f"{names} share an id"


def test_the_pair_that_has_cost_real_picks_is_covered():
    ids = yahoo_ids()
    assert ids["Bijan Robinson"] == "40055"
    assert ids["Brian Robinson Jr."] == "34054"
    atlanta = [p.name for p in load_players()
               if p.team == "ATL" and room_form(p.name) == "b.robinson"]
    assert sorted(atlanta) == ["Bijan Robinson", "Brian Robinson Jr."]


def test_every_yahoo_id_names_a_player_on_the_board():
    names = {p.name for p in load_players()}
    for name in yahoo_ids():
        assert name in names, f"{name} has a Yahoo id but is not on the board"
