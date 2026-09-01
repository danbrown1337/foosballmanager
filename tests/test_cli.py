"""End-to-end tests for the documented command surface.

These run the CLIs as subprocesses against a throwaway copy of the project,
so draft state written mid-test never touches the real working tree. They're
the check that the commands in README.md actually work as written.
"""
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parent.parent


@pytest.fixture(scope="module")
def project(tmp_path_factory):
    """A disposable copy of the project: package plus the data it reads."""
    root = tmp_path_factory.mktemp("project")
    for item in ("fantasy_manager", "config", "data"):
        shutil.copytree(REPO / item, root / item)
    (root / "my_roster.csv").write_text("name,pos,team\n")
    (root / "league_rosters.csv").write_text("team_name,manager,name,pos,team\n")
    return root


def run(project, *argv):
    return subprocess.run(
        [sys.executable, "-m", *argv],
        cwd=project, capture_output=True, text=True,
    )


class TestDraftAssistant:
    def test_board_lists_players(self, project):
        result = run(project, "fantasy_manager.draft_assistant", "board", "--top", "3")
        assert result.returncode == 0
        assert "RANK" in result.stdout
        assert len(result.stdout.strip().splitlines()) == 4  # header + 3

    def test_board_filters_by_position(self, project):
        result = run(project, "fantasy_manager.draft_assistant", "board", "--pos", "TE", "--top", "5")
        assert result.returncode == 0
        rows = result.stdout.strip().splitlines()[1:]
        assert rows and all(" TE " in row for row in rows)

    def test_recommend_reports_roster_scarcity_and_a_pick(self, project):
        result = run(project, "fantasy_manager.draft_assistant", "recommend")
        assert result.returncode == 0
        for section in ("Your roster so far:", "Positional scarcity right now:",
                        "Top recommendation(s):"):
            assert section in result.stdout

    def test_autopick_explains_itself(self, project):
        result = run(project, "fantasy_manager.draft_assistant", "autopick")
        assert result.returncode == 0
        assert "AUTOPICK:" in result.stdout

    def test_unknown_player_fails_loudly(self, project):
        result = run(project, "fantasy_manager.draft_assistant", "pick",
                     "Notta Realplayer", "--by", "mine")
        assert result.returncode == 1
        assert "No close match" in result.stdout

    def test_fuzzy_matches_a_misspelled_name(self, project):
        """Draft rooms move fast; near-misses should still land."""
        result = run(project, "fantasy_manager.draft_assistant", "pick",
                     "Jahmyr Gibs", "--by", "rival")
        assert result.returncode == 0
        assert "Jahmyr Gibbs" in result.stdout
        run(project, "fantasy_manager.draft_assistant", "reset")

    def test_state_survives_between_invocations(self, project):
        """The whole point of the JSON state file — one command per pick, with
        the terminal free to close in between."""
        run(project, "fantasy_manager.draft_assistant", "reset")
        assert run(project, "fantasy_manager.draft_assistant", "pick",
                   "Bijan Robinson", "--by", "mine").returncode == 0

        team = run(project, "fantasy_manager.draft_assistant", "myteam")
        assert "Bijan Robinson" in team.stdout

        board = run(project, "fantasy_manager.draft_assistant", "board", "--top", "25")
        assert "Bijan Robinson" not in board.stdout

        run(project, "fantasy_manager.draft_assistant", "reset")
        assert "Bijan Robinson" in run(
            project, "fantasy_manager.draft_assistant", "board", "--top", "25"
        ).stdout

    def test_double_drafting_is_refused(self, project):
        run(project, "fantasy_manager.draft_assistant", "reset")
        run(project, "fantasy_manager.draft_assistant", "pick", "Puka Nacua", "--by", "rival")
        result = run(project, "fantasy_manager.draft_assistant", "pick",
                     "Puka Nacua", "--by", "mine")
        assert result.returncode == 1
        assert "already marked drafted" in result.stdout
        run(project, "fantasy_manager.draft_assistant", "reset")

    def test_autopick_commit_records_the_pick(self, project):
        run(project, "fantasy_manager.draft_assistant", "reset")
        result = run(project, "fantasy_manager.draft_assistant", "autopick", "--commit")
        assert "Committed:" in result.stdout
        assert run(project, "fantasy_manager.draft_assistant", "myteam").stdout.strip()
        run(project, "fantasy_manager.draft_assistant", "reset")


class TestRosterManager:
    def test_summary_prompts_for_an_empty_roster(self, project):
        result = run(project, "fantasy_manager.roster_manager", "summary")
        assert result.returncode == 0
        assert "No roster on file yet" in result.stdout

    def test_waivers_lists_the_board(self, project):
        result = run(project, "fantasy_manager.roster_manager", "waivers",
                     "--pos", "RB", "--top", "5")
        assert result.returncode == 0
        assert len(result.stdout.strip().splitlines()) == 6

    def test_overachievers_reports_breakout_calls(self, project):
        result = run(project, "fantasy_manager.roster_manager", "overachievers", "--top", "5")
        assert result.returncode == 0
        assert "NOTE" in result.stdout


class TestTradeTargeter:
    def test_list_teams_prompts_when_empty(self, project):
        result = run(project, "fantasy_manager.trade_targeter", "list-teams")
        assert result.returncode == 0
        assert "No rival roster data yet" in result.stdout

    def test_offers_requires_a_target(self, project):
        result = run(project, "fantasy_manager.trade_targeter", "offers")
        assert result.returncode == 0
        assert "No rival roster data yet" in result.stdout


class TestYahooClient:
    def test_refuses_to_run_without_credentials(self, project):
        """Should fail with guidance, not a traceback."""
        result = run(project, "fantasy_manager.yahoo_client", "leagues")
        assert result.returncode != 0
        assert "Traceback" not in result.stderr
        assert "authorize" in (result.stdout + result.stderr)

    def test_init_writes_a_credentials_template(self, project):
        result = run(project, "fantasy_manager.yahoo_client", "init")
        assert result.returncode == 0
        template = project / "config" / "yahoo_credentials.json"
        assert template.exists()
        assert "PASTE_CLIENT_ID_HERE" in template.read_text()
        template.unlink()
