"""Tests for the point-and-click draft assistant.

The web layer is a shell around the same engine the CLI uses, so these check
the shell: that actions mutate draft state correctly, that bad input comes
back as a readable message rather than a traceback, and that the HTTP surface
actually serves.

Draft state is redirected to an in-memory dict throughout — no test may write
draft_state.json into the working tree.
"""
import json
import threading
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

import pytest

from fantasy_manager import web


@pytest.fixture
def state(monkeypatch):
    """Redirect draft state to memory, shared by direct calls and the server."""
    store = {"drafted": {}}
    monkeypatch.setattr(web, "load_draft_state", lambda *a, **k: json.loads(json.dumps(store)))
    monkeypatch.setattr(web, "save_draft_state",
                        lambda s, *a, **k: store.__setitem__("drafted", dict(s["drafted"])))
    return store


class TestSnapshot:
    def test_carries_everything_the_page_needs(self, state):
        snap = web._snapshot()
        assert {"board", "mine", "scarcity", "recommendation",
                "drafted_count", "total"} <= set(snap)

    def test_board_is_the_full_adp_list_sorted_by_adp(self, state):
        board = web._snapshot()["board"]
        assert len(board) == 190
        adps = [p["adp"] for p in board]
        assert adps == sorted(adps), "the UI renders in order without re-sorting"

    def test_starts_with_nothing_drafted(self, state):
        snap = web._snapshot()
        assert snap["drafted_count"] == 0
        assert snap["mine"] == []

    def test_recommends_the_top_of_the_board_when_empty(self, state):
        assert web._snapshot()["recommendation"]["name"] == "Jahmyr Gibbs"

    def test_research_notes_ride_along_for_display(self, state):
        board = web._snapshot()["board"]
        assert any(p["note"] for p in board), "notes should reach the UI"

    def test_is_json_serializable(self, state):
        json.dumps(web._snapshot())


class TestPick:
    def test_marks_a_rival_pick_and_moves_the_recommendation(self, state):
        snap = web.do_pick("Jahmyr Gibbs", "rival")
        assert snap["drafted_count"] == 1
        assert snap["recommendation"]["name"] != "Jahmyr Gibbs"

    def test_marks_my_pick_onto_my_team(self, state):
        snap = web.do_pick("Jahmyr Gibbs", "mine")
        assert [p["name"] for p in snap["mine"]] == ["Jahmyr Gibbs"]

    def test_fuzzy_name_still_lands(self, state):
        """Draft rooms move fast and the UI isn't the only caller."""
        snap = web.do_pick("Jahmyr Gibs", "rival")
        assert snap["drafted_count"] == 1

    def test_unknown_player_is_a_readable_error(self, state):
        with pytest.raises(ValueError, match="No player matching"):
            web.do_pick("Notta Realplayer", "rival")

    def test_double_draft_is_refused(self, state):
        web.do_pick("Jahmyr Gibbs", "rival")
        with pytest.raises(ValueError, match="already marked drafted"):
            web.do_pick("Jahmyr Gibbs", "mine")

    def test_bad_owner_is_refused(self, state):
        with pytest.raises(ValueError, match="mine.*rival"):
            web.do_pick("Jahmyr Gibbs", "somebody_else")


class TestUndo:
    def test_restores_a_player_to_the_board(self, state):
        web.do_pick("Jahmyr Gibbs", "rival")
        snap = web.do_undo("Jahmyr Gibbs")
        assert snap["drafted_count"] == 0
        assert snap["recommendation"]["name"] == "Jahmyr Gibbs"

    def test_undoing_an_undrafted_player_is_harmless(self, state):
        assert web.do_undo("Jahmyr Gibbs")["drafted_count"] == 0


class TestAutopick:
    def test_without_commit_changes_nothing(self, state):
        snap = web.do_autopick(commit=False)
        assert snap["drafted_count"] == 0

    def test_with_commit_adds_to_my_team(self, state):
        snap = web.do_autopick(commit=True)
        assert len(snap["mine"]) == 1
        assert snap["mine"][0]["name"] == "Jahmyr Gibbs"

    def test_reasoning_is_surfaced_for_display(self, state):
        assert web._snapshot()["recommendation"]["reason"]


class TestReset:
    def test_clears_every_pick(self, state):
        web.do_pick("Jahmyr Gibbs", "rival")
        web.do_pick("Puka Nacua", "mine")
        snap = web.do_reset()
        assert snap["drafted_count"] == 0
        assert snap["mine"] == []


class TestFindPort:
    def test_returns_a_usable_port(self):
        import socket
        port = web.find_port(8901)
        with socket.socket() as s:
            s.bind(("127.0.0.1", port))

    def test_skips_a_port_already_in_use(self):
        import socket
        with socket.socket() as taken:
            taken.bind(("127.0.0.1", 0))
            taken.listen()
            busy = taken.getsockname()[1]
            assert web.find_port(busy) != busy


@pytest.fixture
def server(state):
    srv = ThreadingHTTPServer(("127.0.0.1", 0), web.Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{srv.server_address[1]}"
    srv.shutdown()
    srv.server_close()


def get(url):
    with urllib.request.urlopen(url, timeout=10) as r:
        return r.status, r.read().decode()


def post(url, payload):
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=10) as r:
        return r.status, r.read().decode()


class TestHttpSurface:
    def test_serves_the_page(self, server):
        status, body = get(server + "/")
        assert status == 200
        assert "<title>Fantasy Manager</title>" in body

    def test_state_endpoint_returns_the_snapshot(self, server):
        status, body = get(server + "/api/state")
        assert status == 200
        assert json.loads(body)["total"] > 0

    def test_pick_over_http_mutates_state(self, server):
        status, body = post(server + "/api/pick", {"name": "Jahmyr Gibbs", "by": "rival"})
        assert status == 200
        assert json.loads(body)["drafted_count"] == 1

    def test_bad_pick_is_a_400_with_a_readable_message(self, server):
        with pytest.raises(urllib.error.HTTPError) as excinfo:
            post(server + "/api/pick", {"name": "Notta Realplayer", "by": "rival"})
        assert excinfo.value.code == 400
        assert "No player matching" in excinfo.value.read().decode()

    def test_unknown_path_404s(self, server):
        with pytest.raises(urllib.error.HTTPError) as excinfo:
            get(server + "/nope")
        assert excinfo.value.code == 404

    def test_malformed_json_is_a_400_not_a_crash(self, server):
        req = urllib.request.Request(
            server + "/api/pick", data=b"{not json",
            headers={"Content-Type": "application/json"}, method="POST")
        with pytest.raises(urllib.error.HTTPError) as excinfo:
            urllib.request.urlopen(req, timeout=10)
        assert excinfo.value.code == 400
