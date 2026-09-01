#!/usr/bin/env python3
"""
Point-and-click draft assistant.

Start it and a browser opens on the draft board:

    python3 -m fantasy_manager.web

Everything the CLI does, without the CLI: click a player to mark them gone,
see the recommendation update, click again to take one for yourself. The
decision engine is unchanged — this is a shell around autopilot.auto_pick()
and board.py, not a second implementation.

Deliberately stdlib-only (http.server + the PyYAML the project already
needs), so there is nothing extra to install. It binds to 127.0.0.1, so the
server is reachable only from this machine, never the network.

Draft state is the same draft_state.json the CLI and `browser_sync watch`
use, re-read on every request — so the browser, a terminal, and a running
watch loop all stay in agreement rather than fighting each other.
"""
from __future__ import annotations

import argparse
import json
import socket
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from fantasy_manager.autopilot import auto_pick
from fantasy_manager.board import (
    STATE_PATH,
    apply_draft_state,
    build_board,
    load_draft_state,
    save_draft_state,
    scarcity_report,
)

PAGE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Fantasy Manager</title>
<style>
  :root {
    --bg: #f6f7f9; --card: #fff; --ink: #14161a; --muted: #6b7280;
    --line: #e3e6ea; --accent: #1d4ed8; --accent-ink: #fff;
    --good: #047857; --warn: #b45309;
    --mine: #ecfdf5; --rival: #f3f4f6;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0f1115; --card: #171a20; --ink: #e8eaed; --muted: #9aa1ab;
      --line: #262b33; --accent: #7aa2ff; --accent-ink: #0f1115;
      --good: #34d399; --warn: #fbbf24;
      --mine: #0d2b21; --rival: #1e222a;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink);
         font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  header { padding: 14px 20px; border-bottom: 1px solid var(--line);
           background: var(--card); display: flex; gap: 16px; align-items: center;
           position: sticky; top: 0; z-index: 5; flex-wrap: wrap; }
  h1 { font-size: 17px; margin: 0; font-weight: 650; }
  .grow { flex: 1; }
  button { font: inherit; border: 1px solid var(--line); background: var(--card);
           color: var(--ink); border-radius: 8px; padding: 7px 12px; cursor: pointer; }
  button:hover { border-color: var(--accent); }
  button.primary { background: var(--accent); border-color: var(--accent);
                   color: var(--accent-ink); font-weight: 600; }
  button.danger:hover { border-color: #dc2626; color: #dc2626; }
  main { display: grid; grid-template-columns: 1.6fr 1fr; gap: 16px; padding: 16px; align-items: start; }
  @media (max-width: 900px) { main { grid-template-columns: 1fr; } }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 14px 16px; }
  .card h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .06em;
             color: var(--muted); margin: 0 0 10px; font-weight: 650; }
  #rec { border-left: 4px solid var(--accent); }
  #recName { font-size: 22px; font-weight: 700; margin: 2px 0 4px; }
  #recWhy { color: var(--muted); font-size: 13px; }
  .override { color: var(--warn); font-weight: 650; font-size: 13px; margin-top: 6px; }
  input[type=search] { font: inherit; padding: 8px 11px; border: 1px solid var(--line);
                       border-radius: 8px; background: var(--bg); color: var(--ink); min-width: 200px; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: .05em;
       color: var(--muted); padding: 6px 8px; border-bottom: 1px solid var(--line); font-weight: 650; }
  td { padding: 7px 8px; border-bottom: 1px solid var(--line); }
  tr:last-child td { border-bottom: 0; }
  .nm { font-weight: 600; }
  .meta { color: var(--muted); font-size: 12px; }
  .tag { display: inline-block; font-size: 11px; padding: 1px 6px; border-radius: 999px;
         border: 1px solid var(--line); color: var(--muted); }
  .acts { display: flex; gap: 6px; justify-content: flex-end; }
  .acts button { padding: 4px 9px; font-size: 13px; }
  tr.gone { opacity: .45; }
  tr.gone.mine { background: var(--mine); opacity: 1; }
  tr.gone.rival { background: var(--rival); }
  ul.plain { list-style: none; margin: 0; padding: 0; }
  ul.plain li { padding: 5px 0; border-bottom: 1px solid var(--line); font-size: 14px; }
  ul.plain li:last-child { border-bottom: 0; }
  .note { color: var(--warn); font-size: 12px; margin-top: 4px; }
  .empty { color: var(--muted); font-style: italic; }
  .scroll { max-height: 62vh; overflow-y: auto; }
  #err { display: none; background: #7f1d1d; color: #fff; padding: 8px 20px; font-size: 14px; }
</style>
</head>
<body>
<header>
  <h1>Fantasy Manager</h1>
  <input type="search" id="q" placeholder="Search players…" autocomplete="off">
  <select id="pos">
    <option value="">All positions</option>
    <option>QB</option><option>RB</option><option>WR</option>
    <option>TE</option><option>K</option><option>DEF</option>
  </select>
  <label style="font-size:13px;color:var(--muted)">
    <input type="checkbox" id="hide" checked> Hide drafted
  </label>
  <span class="grow"></span>
  <span class="meta" id="count"></span>
  <button class="danger" id="reset">Reset draft</button>
</header>
<div id="err"></div>

<main>
  <div>
    <div class="card" id="rec">
      <h2>Take this</h2>
      <div id="recName">—</div>
      <div id="recWhy"></div>
      <div class="override" id="recOverride" hidden></div>
      <div style="margin-top:12px">
        <button class="primary" id="take">Draft this player for me</button>
      </div>
    </div>

    <div class="card" style="margin-top:16px">
      <h2>Best available</h2>
      <div class="scroll">
        <table>
          <thead><tr><th>Player</th><th>Pos</th><th>ADP</th><th>Tier</th><th></th></tr></thead>
          <tbody id="rows"></tbody>
        </table>
      </div>
    </div>
  </div>

  <div>
    <div class="card">
      <h2>My team (<span id="myCount">0</span>)</h2>
      <ul class="plain" id="mine"><li class="empty">No picks yet.</li></ul>
    </div>
    <div class="card" style="margin-top:16px">
      <h2>Position scarcity</h2>
      <ul class="plain" id="scarcity"></ul>
    </div>
  </div>
</main>

<script>
let STATE = null;

async function api(path, body) {
  const opts = body ? {method: 'POST', headers: {'Content-Type': 'application/json'},
                       body: JSON.stringify(body)} : {};
  const res = await fetch(path, opts);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

function showErr(msg) {
  const el = document.getElementById('err');
  el.textContent = msg;
  el.style.display = msg ? 'block' : 'none';
}

function render() {
  const s = STATE;
  const rec = s.recommendation;
  document.getElementById('recName').textContent =
    rec ? `${rec.name} — ${rec.pos}, ${rec.team} (Tier ${rec.tier})` : 'Board is empty';
  document.getElementById('recWhy').textContent = rec ? rec.reason : '';
  const ov = document.getElementById('recOverride');
  ov.hidden = !(rec && rec.need_override);
  ov.textContent = 'Forced pick — a starting spot is about to go unfilled.';
  document.getElementById('take').disabled = !rec;

  const mine = document.getElementById('mine');
  document.getElementById('myCount').textContent = s.mine.length;
  mine.innerHTML = s.mine.length
    ? s.mine.map(p => `<li><span class="tag">${p.pos}</span> <b>${p.name}</b>
        <span class="meta">${p.team}</span></li>`).join('')
    : '<li class="empty">No picks yet.</li>';

  document.getElementById('scarcity').innerHTML =
    s.scarcity.map(l => `<li>${l}</li>`).join('');
  document.getElementById('count').textContent =
    `${s.drafted_count} of ${s.total} drafted`;

  const q = document.getElementById('q').value.trim().toLowerCase();
  const pos = document.getElementById('pos').value;
  const hide = document.getElementById('hide').checked;

  const rows = s.board.filter(p =>
    (!q || p.name.toLowerCase().includes(q)) &&
    (!pos || p.pos === pos) &&
    (!hide || !p.drafted_by)
  ).slice(0, 300);

  document.getElementById('rows').innerHTML = rows.map(p => {
    const cls = p.drafted_by ? `gone ${p.drafted_by}` : '';
    const acts = p.drafted_by
      ? `<button data-undo="${encodeURIComponent(p.name)}">Undo</button>`
      : `<button data-mine="${encodeURIComponent(p.name)}">Mine</button>
         <button data-rival="${encodeURIComponent(p.name)}">Taken</button>`;
    const note = p.note ? `<div class="note">${p.note_tag}: ${p.note}</div>` : '';
    return `<tr class="${cls}">
      <td><span class="nm">${p.name}</span> <span class="meta">${p.team}</span>${note}</td>
      <td><span class="tag">${p.pos}</span></td>
      <td class="meta">${p.adp}</td>
      <td class="meta">${p.tier}</td>
      <td><div class="acts">${acts}</div></td></tr>`;
  }).join('') || '<tr><td colspan="5" class="empty">No players match.</td></tr>';
}

async function refresh() {
  try { STATE = await api('/api/state'); showErr(''); render(); }
  catch (e) { showErr('Lost contact with the app — is the terminal still running?'); }
}

document.addEventListener('click', async ev => {
  const t = ev.target.closest('button');
  if (!t) return;
  try {
    if (t.dataset.mine)  STATE = await api('/api/pick', {name: decodeURIComponent(t.dataset.mine), by: 'mine'});
    else if (t.dataset.rival) STATE = await api('/api/pick', {name: decodeURIComponent(t.dataset.rival), by: 'rival'});
    else if (t.dataset.undo)  STATE = await api('/api/undo', {name: decodeURIComponent(t.dataset.undo)});
    else if (t.id === 'take') STATE = await api('/api/autopick', {commit: true});
    else if (t.id === 'reset') {
      if (!confirm('Clear every pick and start over?')) return;
      STATE = await api('/api/reset', {});
    } else return;
    showErr(''); render();
  } catch (e) { showErr(String(e.message || e)); }
});

for (const id of ['q', 'pos', 'hide'])
  document.getElementById(id).addEventListener('input', render);

refresh();
// Picks made in a terminal or by `browser_sync watch` show up here too.
setInterval(refresh, 4000);
</script>
</body>
</html>
"""


def _snapshot() -> dict:
    """Everything the page needs, rebuilt from disk so the CLI, the watch
    loop and the browser never disagree about who's been drafted."""
    players, config = build_board()
    apply_draft_state(players, load_draft_state())

    decision = auto_pick(players, config)
    mine = [p for p in players if p.drafted_by == "mine"]
    return {
        "board": [
            {
                "name": p.name, "pos": p.pos, "team": p.team, "adp": p.adp,
                "tier": p.tier, "drafted_by": p.drafted_by,
                "note_tag": p.note_tag, "note": p.note,
            }
            for p in sorted(players, key=lambda p: p.adp)
        ],
        "mine": [{"name": p.name, "pos": p.pos, "team": p.team} for p in
                 sorted(mine, key=lambda p: p.adp)],
        "scarcity": scarcity_report(players, config),
        "recommendation": decision and {
            "name": decision.player.name, "pos": decision.player.pos,
            "team": decision.player.team, "tier": decision.player.tier,
            "reason": decision.reason, "need_override": decision.need_override,
        },
        "drafted_count": sum(1 for p in players if p.drafted_by),
        "total": len(players),
    }


def _resolve(name: str):
    """Find a player by exact name, else the closest match — the browser
    sends names straight from the board, so exact should always hit."""
    from difflib import get_close_matches

    players, _ = build_board()
    by_name = {p.name: p for p in players}
    if name in by_name:
        return by_name[name]
    close = get_close_matches(name, list(by_name), n=1, cutoff=0.6)
    return by_name[close[0]] if close else None


def do_pick(name: str, by: str) -> dict:
    player = _resolve(name)
    if player is None:
        raise ValueError(f"No player matching {name!r}.")
    if by not in ("mine", "rival"):
        raise ValueError("Pick must be 'mine' or 'rival'.")
    state = load_draft_state()
    if player.name in state["drafted"]:
        raise ValueError(f"{player.name} is already marked drafted.")
    state["drafted"][player.name] = by
    save_draft_state(state)
    return _snapshot()


def do_undo(name: str) -> dict:
    state = load_draft_state()
    if name in state["drafted"]:
        del state["drafted"][name]
        save_draft_state(state)
    return _snapshot()


def do_autopick(commit: bool) -> dict:
    players, config = build_board()
    apply_draft_state(players, load_draft_state())
    decision = auto_pick(players, config)
    if decision is None:
        raise ValueError("No players left available.")
    if commit:
        state = load_draft_state()
        state["drafted"][decision.player.name] = "mine"
        save_draft_state(state)
    return _snapshot()


def do_reset() -> dict:
    save_draft_state({"drafted": {}})
    return _snapshot()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):  # keep the terminal readable
        pass

    def _send(self, code, body, ctype="application/json"):
        payload = body if isinstance(body, bytes) else body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        if self.path in ("/", "/index.html"):
            return self._send(200, PAGE, "text/html; charset=utf-8")
        if self.path == "/api/state":
            return self._send(200, json.dumps(_snapshot()))
        self._send(404, json.dumps({"error": "not found"}))

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        try:
            body = json.loads(self.rfile.read(length) or "{}")
        except json.JSONDecodeError:
            return self._send(400, json.dumps({"error": "bad JSON"}))

        routes = {
            "/api/pick": lambda: do_pick(body.get("name", ""), body.get("by", "")),
            "/api/undo": lambda: do_undo(body.get("name", "")),
            "/api/autopick": lambda: do_autopick(bool(body.get("commit"))),
            "/api/reset": do_reset,
        }
        handler = routes.get(self.path)
        if handler is None:
            return self._send(404, json.dumps({"error": "not found"}))
        try:
            self._send(200, json.dumps(handler()))
        except ValueError as err:
            self._send(400, str(err), "text/plain; charset=utf-8")


def find_port(preferred: int) -> int:
    for port in range(preferred, preferred + 20):
        with socket.socket() as s:
            try:
                s.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    raise SystemExit("No free port found between "
                     f"{preferred} and {preferred + 19}.")


def main():
    parser = argparse.ArgumentParser(description="Point-and-click draft assistant")
    parser.add_argument("--port", type=int, default=8777)
    parser.add_argument("--no-browser", action="store_true",
                        help="Don't open a browser window automatically")
    args = parser.parse_args()

    port = find_port(args.port)
    url = f"http://127.0.0.1:{port}/"
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)

    print(f"\n  Fantasy Manager is running at  {url}\n")
    print(f"  Draft state: {STATE_PATH}")
    print("  Leave this window open. Press Ctrl-C when the draft is done.\n")
    if not args.no_browser:
        threading.Timer(0.5, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("Stopped. Your draft is saved.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
