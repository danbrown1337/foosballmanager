"""Tests for per-person profiles.

The point of profiles is that two people share one checkout without ever
seeing each other's league, roster, or draft. These pin that isolation, and
the migration that keeps a hand-filled roster from being lost when an older
single-user checkout is upgraded.

PROFILES_DIR is redirected to a temp directory throughout — no test may
create profiles/ inside the repo.
"""
import os

import pytest

from fantasy_manager import profiles


@pytest.fixture
def sandbox(tmp_path, monkeypatch):
    monkeypatch.setattr(profiles, "PROFILES_DIR", str(tmp_path / "profiles"))
    monkeypatch.setattr(profiles, "ROOT", str(tmp_path))
    monkeypatch.delenv(profiles.ENV_VAR, raising=False)
    return tmp_path


class TestSelection:
    def test_defaults_to_the_default_profile(self, sandbox):
        assert profiles.active_profile() == "default"

    def test_env_var_selects(self, sandbox, monkeypatch):
        monkeypatch.setenv(profiles.ENV_VAR, "alex")
        assert profiles.active_profile() == "alex"

    def test_set_active_profile_takes_effect(self, sandbox):
        profiles.set_active_profile("dan")
        assert profiles.active_profile() == "dan"

    def test_setting_none_leaves_the_current_one(self, sandbox, monkeypatch):
        monkeypatch.setenv(profiles.ENV_VAR, "dan")
        assert profiles.set_active_profile(None) == "dan"


class TestPaths:
    def test_every_per_person_file_lives_in_the_profile(self, sandbox):
        for path in (profiles.config_path("dan"), profiles.my_roster_path("dan"),
                     profiles.league_rosters_path("dan"), profiles.draft_state_path("dan"),
                     profiles.credentials_path("dan"), profiles.tokens_path("dan")):
            assert profiles.profile_dir("dan") == os.path.dirname(path)

    def test_two_people_never_share_a_path(self, sandbox):
        for resolver in (profiles.config_path, profiles.my_roster_path,
                         profiles.draft_state_path, profiles.credentials_path):
            assert resolver("dan") != resolver("alex")

    def test_rankings_are_shared_not_per_person(self, sandbox):
        """ADP and the research notes are general 2026 data, not anyone's league."""
        assert "profiles" not in profiles.DEFAULT_ADP
        assert "profiles" not in profiles.DEFAULT_NOTES


class TestEnsureProfile:
    def test_creates_and_seeds_from_the_template(self, sandbox):
        directory = profiles.ensure_profile("dan")
        assert os.path.isdir(directory)
        assert os.path.isfile(profiles.config_path("dan"))
        assert "league:" in open(profiles.config_path("dan")).read()

    def test_seeds_empty_roster_files_with_headers(self, sandbox):
        profiles.ensure_profile("dan")
        assert open(profiles.my_roster_path("dan")).read() == "name,pos,team\n"
        assert open(profiles.league_rosters_path("dan")).read().startswith("team_name,")

    def test_is_idempotent_and_never_overwrites_edits(self, sandbox):
        profiles.ensure_profile("dan")
        with open(profiles.config_path("dan"), "w") as f:
            f.write("league:\n  name: Edited\n")
        profiles.ensure_profile("dan")
        assert "Edited" in open(profiles.config_path("dan")).read()

    def test_exists_reflects_reality(self, sandbox):
        assert not profiles.exists("dan")
        profiles.ensure_profile("dan")
        assert profiles.exists("dan")


class TestListProfiles:
    def test_empty_before_anything_is_created(self, sandbox):
        assert profiles.list_profiles() == []

    def test_lists_created_profiles_sorted(self, sandbox):
        profiles.ensure_profile("dan")
        profiles.ensure_profile("alex")
        assert profiles.list_profiles() == ["alex", "dan"]

    def test_ignores_stray_directories(self, sandbox):
        profiles.ensure_profile("dan")
        os.makedirs(os.path.join(profiles.PROFILES_DIR, "not-a-profile"))
        assert profiles.list_profiles() == ["dan"]


class TestLegacyMigration:
    """An older checkout kept these in the repo root. Losing a hand-filled
    roster to a refactor would be unforgivable, so real ones get moved in."""

    def test_a_filled_roster_is_carried_over(self, sandbox):
        (sandbox / "my_roster.csv").write_text("name,pos,team\nJahmyr Gibbs,RB,DET\n")
        profiles.ensure_profile("default")
        assert "Jahmyr Gibbs" in open(profiles.my_roster_path("default")).read()

    def test_a_header_only_file_is_not_migrated(self, sandbox):
        (sandbox / "my_roster.csv").write_text("name,pos,team\n")
        profiles.ensure_profile("default")
        assert open(profiles.my_roster_path("default")).read() == "name,pos,team\n"

    def test_live_draft_state_is_carried_over(self, sandbox):
        (sandbox / "draft_state.json").write_text('{"drafted": {"Jahmyr Gibbs": "mine"}}')
        profiles.ensure_profile("default")
        assert "Jahmyr Gibbs" in open(profiles.draft_state_path("default")).read()

    def test_existing_profile_content_is_never_clobbered(self, sandbox):
        profiles.ensure_profile("default")
        with open(profiles.my_roster_path("default"), "w") as f:
            f.write("name,pos,team\nPuka Nacua,WR,LAR\n")
        (sandbox / "my_roster.csv").write_text("name,pos,team\nJahmyr Gibbs,RB,DET\n")
        profiles.ensure_profile("default")
        content = open(profiles.my_roster_path("default")).read()
        assert "Puka Nacua" in content and "Jahmyr Gibbs" not in content

    def test_absent_legacy_files_are_fine(self, sandbox):
        profiles.ensure_profile("default")  # must not raise
