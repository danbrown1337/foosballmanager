import { Storage, DEFAULT_CONFIG, MOCK_STARTERS } from "../lib/storage.js";
import { parseLeaguePage } from "../lib/textMatch.js";

const POSITIONS = ["QB", "RB", "WR", "TE", "FLEX", "K", "DEF"];

function flash(id) {
  const el = document.getElementById(id);
  el.hidden = false;
  setTimeout(() => (el.hidden = true), 2000);
}

async function loadForm() {
  const config = await Storage.getConfig();
  document.getElementById("leagueName").value = config.league.name || "";
  document.getElementById("numTeams").value = config.league.num_teams || 10;
  document.getElementById("scoring").value = config.league.scoring || "ppr";

  for (const pos of POSITIONS) {
    document.getElementById(`s_${pos}`).value = config.roster.starters[pos] ?? "";
  }
  document.getElementById("s_bench").value = config.roster.bench ?? 6;
  document.getElementById("s_ir").value = config.roster.ir ?? 0;

  document.getElementById("strategy").value = config.autopilot?.strategy || "best_player_available";
  document.getElementById("risk").value = config.autopilot?.risk_tolerance || "balanced";
  document.getElementById("benchCap").value = config.autopilot?.max_bench_per_pos ?? 3;

  const rosters = await Storage.getLeagueRosters();
  renderTeamList(rosters);

  const phrases = await Storage.getTurnPhrases();
  document.getElementById("turnPhrases").value = phrases.join("\n");

  const confirmPhrases = await Storage.getConfirmPhrases();
  document.getElementById("confirmPhrases").value = confirmPhrases.join("\n");

  await renderPractice();
}

async function renderPractice() {
  const { active } = await Storage.getPractice();
  const card = document.getElementById("practiceCard");
  card.classList.toggle("practice-on", active);
  document.getElementById("practiceState").textContent = active
    ? "ON — these are mock settings, not your league's. Turn this off before your real draft."
    : "Off — the settings below are your league's.";
  document.getElementById("practiceToggle").textContent = active
    ? "Restore my league settings"
    : "Switch to Yahoo mock settings";
}

document.getElementById("practiceToggle").addEventListener("click", async () => {
  const practice = await Storage.getPractice();
  if (practice.active) {
    // Restore verbatim rather than recomputing: whatever was there before is
    // the only thing that's certainly right.
    if (practice.savedConfig) await Storage.setConfig(practice.savedConfig);
    await Storage.setPractice({ active: false, savedConfig: null });
  } else {
    const config = await Storage.getConfig();
    await Storage.setPractice({ active: true, savedConfig: config });
    await Storage.setConfig({
      ...config,
      roster: { ...config.roster, starters: { ...MOCK_STARTERS } },
    });
  }
  await loadForm();
});

function renderTeamList(rosters) {
  const names = Object.keys(rosters);
  document.getElementById("teamList").textContent = names.length
    ? `${names.length} team(s) on file: ${names.join(", ")}`
    : "No rosters imported yet.";
}

document.getElementById("save").addEventListener("click", async () => {
  const starters = {};
  for (const pos of POSITIONS) {
    const raw = document.getElementById(`s_${pos}`).value;
    const n = raw === "" ? 0 : parseInt(raw, 10);
    // A position left blank/0 is dropped entirely, not stored as "0" — the
    // engine treats "absent from starters" as "never draft this" (see
    // autopilot.js), which only works if the key genuinely isn't there.
    if (n > 0) starters[pos] = n;
  }

  const config = {
    league: {
      name: document.getElementById("leagueName").value || "My League",
      num_teams: parseInt(document.getElementById("numTeams").value, 10) || 10,
      scoring: document.getElementById("scoring").value,
    },
    roster: {
      starters,
      bench: parseInt(document.getElementById("s_bench").value, 10) || 0,
      ir: parseInt(document.getElementById("s_ir").value, 10) || 0,
    },
    autopilot: {
      strategy: document.getElementById("strategy").value,
      risk_tolerance: document.getElementById("risk").value,
      max_bench_per_pos: parseInt(document.getElementById("benchCap").value, 10) || 0,
    },
    rivals: (await Storage.getConfig()).rivals || [],
  };

  await Storage.setConfig(config);
  flash("saveStatus");
});

document.getElementById("importRosters").addEventListener("click", async () => {
  const text = document.getElementById("leagueRostersText").value;
  const teams = parseLeaguePage(text);
  delete teams[""]; // an unlabeled leading block isn't a real team name
  await Storage.setLeagueRosters(teams);
  renderTeamList(teams);
  document.getElementById("importStatus").textContent =
    `Imported ${Object.keys(teams).length} team(s), ` +
    `${Object.values(teams).reduce((n, v) => n + v.length, 0)} player(s).`;
  flash("importStatus");
});

document.getElementById("saveTurnPhrases").addEventListener("click", async () => {
  const phrases = document.getElementById("turnPhrases").value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  await Storage.setTurnPhrases(phrases);
  flash("turnPhrasesStatus");
});

document.getElementById("saveConfirmPhrases").addEventListener("click", async () => {
  const phrases = document.getElementById("confirmPhrases").value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  await Storage.setConfirmPhrases(phrases);
  flash("confirmPhrasesStatus");
});

document.getElementById("resetDraft").addEventListener("click", async () => {
  if (!confirm("Clear every recorded pick? League settings and rosters are kept.")) return;
  await Storage.resetDraftState();
  flash("resetStatus");
});

loadForm().catch((err) => {
  console.error(err);
  alert(`Couldn't load settings: ${err.message || err}`);
});
