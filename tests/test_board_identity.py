"""
The draft room abbreviates: "B. ROBINSON (RB · ATL)". First initial, surname,
position and team are every discriminator it ever gives us, so two players on
the board sharing all four cannot be told apart by anything downstream —
announcements, roster reads, or grading.

That was a live bug for six drafts: Brian Robinson Jr. was listed on Atlanta
alongside Bijan, so "B. Robinson RB Atl" was genuinely ambiguous and the
grader kept reporting a second-round steal as a D. See the extension's
boardIdentity test for the same guard on the shipped JSON.
"""
from __future__ import annotations

import collections

from fantasy_manager.board import load_players


def room_form(name: str) -> str:
    parts = name.replace(".", " ").split()
    if len(parts) < 2:
        return name.lower()
    return f"{parts[0][0]}.{' '.join(parts[1:])}".lower()


def test_no_two_players_are_indistinguishable_in_a_room():
    groups = collections.defaultdict(list)
    for p in load_players():
        groups[(room_form(p.name), p.pos, p.team)].append(p.name)
    clashes = {k: v for k, v in groups.items() if len(v) > 1}
    assert not clashes, f"the room cannot tell these apart — check the team column: {clashes}"


def test_shared_surname_and_position_is_resolved_by_team():
    groups = collections.defaultdict(list)
    for p in load_players():
        groups[(room_form(p.name), p.pos)].append(p)
    for key, group in groups.items():
        if len(group) < 2:
            continue
        teams = {p.team for p in group}
        assert len(teams) == len(group), (
            f"{key}: {[(p.name, p.team) for p in group]}"
        )


def test_bijan_is_the_only_b_robinson_on_atlanta():
    hits = [p.name for p in load_players()
            if p.team == "ATL" and room_form(p.name) == "b.robinson"]
    assert hits == ["Bijan Robinson"]
