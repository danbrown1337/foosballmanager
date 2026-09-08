/*
 * Finds clickable elements on the live draft-room page by their visible
 * text — the same "search text, not structure" philosophy as
 * findBoardNames() in textMatch.js, extended from reading to (optionally)
 * clicking.
 *
 * HONEST LIMIT: this environment has no access to fantasysports.yahoo.com,
 * so these functions were built and verified against a synthetic page
 * (test/domActions.check.js) modeled on common draft-room patterns
 * (player rows as buttons/links/clickable divs, a confirm dialog with a
 * labeled button) — not against Yahoo's real DOM, which nobody on this
 * project has been able to inspect from here. Test against a real Yahoo
 * mock draft before trusting the "fully automatic" mode.
 *
 * Every function here takes its search root as a parameter instead of
 * reaching for the global `document`, so it can be exercised against any
 * DOM — a real page in a browser test, or a synthetic fixture.
 */

/* Kept alongside textMatch's copy deliberately: this module is loaded on its
 * own by the click paths, and a defence that cannot be found is a slot that
 * cannot be filled. */
const DEFENCE_NICKNAMES = {
  ARI: "Cardinals", ATL: "Falcons", BAL: "Ravens", BUF: "Bills", CAR: "Panthers",
  CHI: "Bears", CIN: "Bengals", CLE: "Browns", DAL: "Cowboys", DEN: "Broncos",
  DET: "Lions", GB: "Packers", HOU: "Texans", IND: "Colts", JAX: "Jaguars",
  KC: "Chiefs", LV: "Raiders", LAC: "Chargers", LAR: "Rams", MIA: "Dolphins",
  MIN: "Vikings", NE: "Patriots", NO: "Saints", NYG: "Giants", NYJ: "Jets",
  PHI: "Eagles", PIT: "Steelers", SF: "49ers", SEA: "Seahawks", TB: "Buccaneers",
  TEN: "Titans", WAS: "Commanders",
};

const CLICKABLE_SELECTOR = 'button, a, [role="button"], input[type="submit"], [onclick]';

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// The extension's own floating panel repeats the recommended player's name
// and has a button whose label contains "draft" — both would otherwise
// match our own search targets meant for Yahoo's page.
function isInsideOwnOverlay(el) {
  return !!el.closest?.("#fantasy-manager-overlay");
}

function normalizeText(text) {
  return (text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Find the best element to click to select `playerName` on the page.
 * Walks up from the matching text node looking for the nearest ancestor
 * that looks interactive (button/link/role=button/onclick); falls back to
 * the text node's immediate parent element if nothing more specific is
 * found within `maxAncestorDepth`, since many draft rooms attach a click
 * handler directly to a row div rather than using a real <button>. */
/* "Jahmyr Gibbs" never appears in a Yahoo draft room — every name there is
 * "J. Gibbs", or "J. GIBBS" in the pick feed. Searching only for the full
 * name is why auto-draft could detect a turn, hold a correct recommendation,
 * and still never click anything: the element it was looking for did not
 * exist on the page. */
function abbrevForms(name) {
  const parts = name.trim().split(/\s+/);
  if (parts.length < 2) return [];
  const tail = parts[parts.length - 1].replace(/[.,]/g, "");
  const last = /^(jr|sr|ii|iii|iv|v)$/i.test(tail) && parts.length > 2
    ? parts[parts.length - 2]
    : tail;
  return [`${parts[0][0]}. ${last}`, `${parts[0][0]}.${last}`];
}

/* The ADP the room prints on one row, read from its table's ADP column.
 *
 * Used to tell two players apart when nothing else can. Bijan Robinson and
 * Brian Robinson are both running backs for Atlanta, so an abbreviated name,
 * a position and a team are all identical between them — the room writes
 * "B. ROBINSON" for each. Their ADPs are 2.3 and 152.9. */
/* Only a gulf this size is evidence of the wrong player, and only when the
 * row is alone. Two competing rows are judged against each other instead,
 * where a much finer comparison is sound. */
const SINGLE_ROW_ADP_GULF = 100;

export function rowAdp(row) {
  const table = row.closest?.("table");
  if (!table) return null;
  const headerRows = [...table.querySelectorAll("thead tr")];
  const headers = headerRows.length ? [...headerRows[headerRows.length - 1].children] : [];
  const adpCol = headers.findIndex((th) => /^adp$/i.test((th.textContent || "").trim()));
  if (adpCol < 0) return null;
  const value = Number((row.children[adpCol]?.textContent || "").trim());
  return Number.isFinite(value) && value > 0 ? value : null;
}

/* Yahoo's own player id, off the row.
 *
 * The room writes "B. Robinson", and Bijan and Brian Robinson Jr. are both
 * Atlanta running backs — initial, surname, position and team are every
 * discriminator the text has, and they are identical for two players a
 * hundred and fifty ADP places apart. Reading them is hopeless by
 * construction, which is why this cost a first-round pick more than once.
 *
 * The markup is not ambiguous at all. Each row carries data-id, and the
 * headshot URL ends in the same number:
 *
 *   data-id="34054"
 *   .../nfl_cutout/players_l/08252026/34054.1.png
 *
 * 40055 is Bijan. 34054 is Brian. Exact, and it was there all along.
 */
export function rowYahooId(row) {
  if (!row) return null;
  const holder = row.matches?.("[data-id]") ? row : row.querySelector?.("[data-id]");
  const attr = holder?.getAttribute?.("data-id");
  if (attr && /^\d{3,8}$/.test(attr.trim())) return attr.trim();
  const img = row.querySelector?.("img[src]");
  const m = img && /\/(\d{3,8})\.\d+\.(?:png|jpg|webp)/.exec(img.getAttribute("src") || "");
  return m ? m[1] : null;
}

/* The position written on the row, when the row states one plainly.
 *
 * Cells only, and only when exactly one position token appears: a row that
 * says two things, or nothing, gets no opinion rather than a guess. */
const POSITION_CELLS = new Set(["QB", "RB", "WR", "TE", "K", "DEF"]);

export function rowPosition(row) {
  if (!row?.querySelectorAll) return null;
  const found = new Set();
  for (const cell of row.querySelectorAll("td, th, span, abbr, div")) {
    const text = (cell.textContent || "").trim().toUpperCase();
    if (POSITION_CELLS.has(text)) found.add(text);
  }
  return found.size === 1 ? [...found][0] : null;
}

export function findPlayerClickTarget(root, playerName, { maxAncestorDepth = 6, player = null } = {}) {
  const doc = root.ownerDocument || root;
  /* A defence's row says "Texans", never "Houston Defense", so the name we
   * hold cannot be found on the page at all. Search for the nickname instead;
   * the team already identifies it uniquely. */
  if (player?.pos === "DEF" && player.team && DEFENCE_NICKNAMES[player.team.toUpperCase()]) {
    playerName = DEFENCE_NICKNAMES[player.team.toUpperCase()];
  }
  const re = new RegExp(`(?<!\\w)${escapeRegExp(playerName)}(?!\\w)`);
  const abbrevRes = abbrevForms(playerName).map(
    (form) => new RegExp(`(?<!\\w)${escapeRegExp(form)}(?!\\w)`, "i")
  );

  /* An abbreviation can name more than one player, and clicking the wrong row
   * drafts the wrong player — irreversible, unlike a missed detection. So an
   * abbreviated match is only accepted when the surrounding row also shows
   * this player's team or position. */
  const confirmedByContext = (node, form) => {
    if (!player) return true;
    // Team, not position: two players sharing an abbreviation usually share a
    // position too (Bijan and Brian Robinson are both RBs), so accepting a
    // position match would happily click either row. Position is only used
    // when no team is known at all.
    const required = player.team || player.pos;
    if (!required) return true;
    let el = node.parentElement;
    for (let d = 0; el && d < maxAncestorDepth; d++, el = el.parentElement) {
      const text = el.textContent || "";
      if (text.length > 300) break;
      /* Stop before an ancestor holding a second player with this same
       * abbreviation: its text is the list, not this row, and a neighbouring
       * row's team would otherwise "confirm" the wrong player. */
      if (countMentions(text, form) > 1) break;
      /* Cell by cell, not by pattern. textContent runs the cells together —
       * a row reads "B. RobinsonRBAtlBye 11" — so "Atl" sits between two
       * capitals, where a word-boundary test fails and even textMentions
       * fails, since that only relaxes the trailing side. Team confirmation
       * was therefore failing on every row in the real room, which is what
       * "couldn't confirm Chase Brown" meant in the log. The room gives each
       * value its own cell, so ask the cells. */
      if (showsValue(el, required)) return true;
    }
    return false;
  };

  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue) return NodeFilter.FILTER_SKIP;
      if (isInsideOwnOverlay(node.parentElement)) return NodeFilter.FILTER_SKIP;
      if (re.test(node.nodeValue)) return NodeFilter.FILTER_ACCEPT;
      const forms = abbrevForms(playerName);
      const matched = forms.find((form, i) => abbrevRes[i].test(node.nodeValue));
      if (matched && confirmedByContext(node, matched)) return NodeFilter.FILTER_ACCEPT;
      return NodeFilter.FILTER_SKIP;
    },
  });

  /* Collect every match rather than taking the first.
   *
   * Taking the first drafted Brian Robinson with the eighth pick of a draft,
   * where the intended player was Bijan — same initial, same surname, same
   * position, same team, and so nothing above can separate them. The panel
   * had already noticed the collision and said so in its log; only this path
   * went ahead regardless. */
  const matches = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    matches.push(node);
    if (matches.length >= 8) break; // a real collision is two rows, not eight
  }
  if (matches.length === 0) return null;

  /* The id settles it, when we have one.
   *
   * Everything below arbitrates on ADP, which is a proxy: it needs the room
   * to publish a number, needs that number to be near the board's, and gives
   * up when two rows are close. For the one case it exists to solve it kept
   * failing — a room that prints no ADP for a bench back leaves both rows
   * unscored, arbitration finds no rivals, and the first match wins, which is
   * how Brian Robinson kept arriving in place of Bijan.
   *
   * Yahoo's id is not a proxy. A row that carries a different player's id is
   * not this player, whatever his name reads as, and a row carrying his own
   * needs no further argument. */
  const rowOf = (node) => node.parentElement?.closest?.("tr, [role='row']") || null;
  if (player?.yahooId) {
    const want = String(player.yahooId);
    const idOf = (node) => rowYahooId(rowOf(node));
    const his = matches.filter((n) => idOf(n) === want);
    if (his.length > 0) {
      matches.length = 0;
      matches.push(...his);
    } else {
      /* No row claims him. Drop the ones that positively belong to someone
       * else and judge what is left; if that is nothing, the room is showing
       * a different player under his name and there is nobody to click. */
      const notRuledOut = matches.filter((n) => {
        const id = idOf(n);
        return !id || id === want;
      });
      if (notRuledOut.length === 0) return null;
      matches.length = 0;
      matches.push(...notRuledOut);
    }
  }

  /* A row that states a different position is a different player.
   *
   * The abbreviation path already demands the row show this player's team,
   * because "B. Robinson" names two Atlanta backs. The full-name path demanded
   * nothing at all — a name matched exactly was accepted wherever it appeared.
   * That is fine until two players genuinely share a name: the board's Mike
   * Evans is a receiver in San Francisco, and a roster panel came back reading
   * "M. Evans TE Car".
   *
   * Position is the one discriminator a room always writes and never
   * abbreviates differently — team codes vary between sources, "WR" does not.
   * So a row positively stating another position is dropped, whatever its name
   * reads as. If that leaves nothing, the turn finds no target and falls
   * through to the queue, which is the right way to lose this argument: a
   * missed pick is recoverable and the wrong player is not. */
  if (player?.pos) {
    const want = String(player.pos).trim().toUpperCase();
    const consistent = matches.filter((node) => {
      const shown = rowPosition(rowOf(node));
      return shown === null || shown === want;
    });
    if (consistent.length !== matches.length) {
      matches.length = 0;
      matches.push(...consistent);
    }
    if (matches.length === 0) return null;
  }

  /* Several matches are usually one player written in several places — the
   * pick feed, the queue panel, his row — not two players. A collision is
   * specifically two different rows of the same table competing for the name,
   * which is the only case worth arbitrating. */
  const rowsSeen = new Map();
  for (const node of matches) {
    const row = node.parentElement?.closest?.("tr, [role='row']");
    if (!row || rowsSeen.has(row)) continue;
    rowsSeen.set(row, { node, adp: rowAdp(row) });
  }

  /* A row with nothing in it is not a row.
   *
   * The list is virtualised and leaves empty shells behind, and a name can
   * match inside one — the panel reported "row present (0 cells, 0 controls,
   * icons none) but no Draft button" for Derrick Henry at a turn, having
   * locked onto one of these and stopped looking. The pick went to Yahoo's
   * autodraft. A match in a real row is always the better answer, so shells
   * are dropped whenever there is any alternative. */
  const hasSubstance = (node) => {
    const row = node.parentElement?.closest?.("tr, [role='row']");
    if (!row) return true; // not in a row at all: judged elsewhere, not here
    return (row.children?.length || 0) > 0 ||
      row.querySelectorAll(CLICKABLE_SELECTOR).length > 0;
  };
  const substantial = matches.filter(hasSubstance);
  const usable = substantial.length > 0 ? substantial : matches;

  let textNode = usable[0];
  const rivals = [...rowsSeen.values()].filter((r) => r.adp !== null);
  if (rivals.length > 1) {
    /* ADP is the one thing that still tells them apart, and the board knows
     * the intended player's. Pick the row nearest it, and only when the
     * choice is clear: a wrong click drafts a player and cannot be undone,
     * so an unreadable or ambiguous column means walking away, not guessing. */
    const wanted = Number(player?.adp);
    if (!Number.isFinite(wanted)) return null;
    const scored = rivals
      .map((r) => ({ node: r.node, gap: Math.abs(r.adp - wanted) }))
      .sort((a, b) => a.gap - b.gap);
    if (scored.length > 1 && scored[1].gap - scored[0].gap < 5) return null;
    if (scored[0].gap > 40) return null; // nearest is still not this player
    textNode = scored[0].node;
  } else if (rivals.length === 1) {
    /* One row is not proof of no collision: the list mounts a dozen rows at a
     * time, so the other Robinson may simply be scrolled out. Where both the
     * board and the row state an ADP, they have to be in the same
     * neighbourhood.
     *
     * The tolerance is very wide on purpose. The board's number is often not
     * an ADP at all: a league player list with no ADP column falls back to
     * list position, and the consensus feed covers about four fifths of a
     * pool, so a legitimate row routinely sits tens of places from what the
     * board holds. Vetoing on a smaller gap would reject real rows and leave
     * the queue unable to star anyone. Namesakes are separated by far more
     * than this — Bijan and Brian Robinson are a hundred and fifty apart. */
    const wanted = Number(player?.adp);
    if (Number.isFinite(wanted) && Math.abs(rivals[0].adp - wanted) > SINGLE_ROW_ADP_GULF) return null;
    textNode = rivals[0].node;
  }

  let el = textNode.parentElement;
  let fallback = el;
  for (let depth = 0; el && depth < maxAncestorDepth; depth++, el = el.parentElement) {
    if (el.matches?.(CLICKABLE_SELECTOR)) return el;
  }
  return fallback;
}

/** The surname a draft room shows, suffixes dropped: "Marvin Harrison Jr."
 * searches as "Harrison". */
export function surnameOf(name) {
  const parts = name.trim().split(/\s+/);
  if (parts.length < 2) return name.trim();
  const tail = parts[parts.length - 1].replace(/[.,]/g, "");
  return /^(jr|sr|ii|iii|iv|v)$/i.test(tail) && parts.length > 2 ? parts[parts.length - 2] : tail;
}

/* Yahoo renders only a window of the player list — the recommended player is
 * usually not in the DOM at all, so there is nothing to click and no name
 * matching can produce one. The room's own search box is how a person deals
 * with this, and it's how auto-draft has to as well. */
export function findPlayerSearchBox(root) {
  const inputs = root.querySelectorAll("input[type=text], input:not([type])");
  for (const el of inputs) {
    if (isInsideOwnOverlay(el)) continue;
    const hint = `${el.placeholder || ""} ${el.getAttribute("aria-label") || ""}`;
    if (/search/i.test(hint) && /player/i.test(hint)) return el;
  }
  return null;
}

/* Frameworks track input state internally and ignore a plain `.value =`,
 * so set through the native descriptor and fire the event React and friends
 * actually listen for. */
export function setInputValue(input, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  if (setter) setter.call(input, value);
  else input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

/* The control that adds a player to the room's queue — the star beside their
 * row. Nobody here has seen Yahoo's markup for it, so this tries the things
 * it could plausibly be, most explicit first, and returns null rather than
 * clicking something it can't identify. A wrong click in a draft room is
 * worse than not queueing.
 *
 * The row is bounded the same way abbreviated names are confirmed: stop
 * climbing before an ancestor that holds another player, or the "star" found
 * would belong to a neighbour. */
/* Every place this player's name appears, as elements. The name shows up in
 * the pick feed and the queue panel as well as in his row, and taking only
 * the first occurrence meant the lookup often landed somewhere with no row
 * around it — reported live as "found Omarion Hampton but no star on his
 * row" while 101 stars sat on the page. */
function nameOccurrences(root, playerName) {
  const doc = root.ownerDocument || root;
  const forms = [playerName, ...abbrevForms(playerName)];
  const res = forms.map((f) => new RegExp(`(?<!\\w)${escapeRegExp(f)}(?!\\w)`, "i"));
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue || isInsideOwnOverlay(node.parentElement)) return NodeFilter.FILTER_SKIP;
      return res.some((re) => re.test(node.nodeValue))
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_SKIP;
    },
  });
  const out = [];
  for (let n = walker.nextNode(); n && out.length < 12; n = walker.nextNode()) {
    if (n.parentElement) out.push(n.parentElement);
  }
  return out;
}

/* What the page actually shows for this player, for a panel that has to
 * explain why it could not act.
 *
 * "found X but no star on his row" and "no Draft button on his row" have two
 * quite different causes that want opposite treatment. Either the player is
 * gone — taken players leave the available list while their names stay in the
 * pick feed and the Last banner, so the name resolves with no row behind it
 * at all — or his row is right there and the control did not render. The
 * first is evidence of a pick. The second must never be treated as one. This
 * says which, so the difference stops being a guess. */
export function describeRow(root, playerName, { player = null } = {}) {
  const el = findPlayerClickTarget(root, playerName, { player });
  if (!el) return { found: false, inTable: false, cells: 0, icons: [], controls: 0 };
  const row = el.closest?.("tr, [role='row']");
  if (!row) {
    return { found: true, inTable: false, cells: 0, icons: [], controls: 0 };
  }
  return {
    found: true,
    inTable: true,
    cells: row.children?.length ?? 0,
    icons: [...row.querySelectorAll("svg")]
      .map((s) => s.getAttribute("data-icon") || "?")
      .slice(0, 6),
    controls: row.querySelectorAll(CLICKABLE_SELECTOR).length,
  };
}

/* One of the room's right-hand panel tabs — "Queue" or "Picks" — by its exact
 * label. Exact, because "Picks" also appears inside "You're up in 3 Picks",
 * and clicking that is clicking something else entirely. */
export function findPanelTab(root, label) {
  const doc = root.ownerDocument || root;
  const wanted = label.trim().toLowerCase();
  for (const el of doc.querySelectorAll(CLICKABLE_SELECTOR)) {
    if ((el.textContent || "").trim().toLowerCase() === wanted) return el;
  }
  return null;
}

/* The star control on one row, or null if that row shows the player already
 * queued. Undefined means this row has no star at all. */
function starOnRow(row) {
  const star = row?.querySelector('[data-icon*="star" i]');
  if (!star) return undefined;
  const icon = star.getAttribute("data-icon") || "";
  // "star-unfilled" means not queued; a filled star is the remove control,
  // and clicking it would take the player back out of the queue.
  if (!/unfilled/i.test(icon) && /filled/i.test(icon)) return null;
  return star.closest(CLICKABLE_SELECTOR) || star.parentElement || undefined;
}

export function findQueueStar(root, playerName, { player = null } = {}) {
  /* Ask the resolver which row is his, rather than starring the first row
   * that carries the abbreviation.
   *
   * This scanned occurrences directly and starred whichever matching row came
   * first in the DOM, so every disambiguation this file does — team,
   * position, ADP between two rows that share all three — was skipped
   * entirely on the queue path, because findPlayerClickTarget was only ever
   * the fallback and the scan always succeeded first. Bijan and Brian
   * Robinson are both Atlanta running backs and the room writes
   * "B. ROBINSON" for each; the wrong one was queued three separate times,
   * and each time the fix went into a function this path never called. */
  if (player) {
    const target = findPlayerClickTarget(root, playerName, { player });
    const row = target?.closest?.("tr, [role='row']");
    if (!row) return null;
    const star = starOnRow(row);
    /* Undefined means his row has no star — nothing to click, and no reason
     * to go looking at other players' rows for one. Refusing here is the
     * whole point: when the resolver cannot tell two players apart it returns
     * nothing, and a scan that ignores it would undo that. */
    return star === undefined ? null : star;
  }

  /* No identity to check against — the caller knows only a name. Scan, since
   * there is nothing better available. */
  for (const el of nameOccurrences(root, playerName)) {
    const row = el.closest?.("tr, [role='row']");
    const star = starOnRow(row);
    if (star === undefined) continue;
    return star;
  }

  const nameEl = findPlayerClickTarget(root, playerName, { player });
  if (!nameEl) return null;

  /* Yahoo lays each player out as a table row: the star sits in the row's
   * first cell and the name in the second, so anything scoped to the name's
   * own cell — as this was — can never reach it. Climb to the row.
   *
   * Confirmed against a live draft room, 2026-09-04:
   *   TD #1: svg[data-icon="star-unfilled"], one clickable
   *   TD #2: "B. Bowers TE LV Bye 13"
   */
  const row = nameEl.closest?.("tr, [role='row']");
  const scope = row || nameEl.parentElement;
  if (!scope) return null;

  const star = scope.querySelector('[data-icon*="star" i]');
  if (star) {
    // "star-unfilled" means not queued; a filled star is the remove control,
    // and clicking it would take the player back out of the queue.
    const icon = star.getAttribute("data-icon") || "";
    if (!/unfilled/i.test(icon) && /filled/i.test(icon)) return null;
    return star.closest(CLICKABLE_SELECTOR) || star.parentElement || null;
  }

  // Fallbacks for a layout that isn't the one above: something that says what
  // it is, then a control in the row carrying no text of its own. Returns null
  // rather than clicking anything it cannot identify.
  const candidates = [...scope.querySelectorAll(CLICKABLE_SELECTOR)].filter(
    (el) => !isInsideOwnOverlay(el)
  );
  for (const el of candidates) {
    const label = `${el.getAttribute("aria-label") || ""} ${el.getAttribute("title") || ""}`;
    if (/queue|watch ?list/i.test(label)) return el;
  }
  for (const el of candidates) {
    if (/star/i.test(el.getAttribute("class") || "")) return el;
    const text = (el.textContent || "").trim();
    if (!text && el !== nameEl && !el.contains(nameEl)) return el;
  }
  return null;
}

/* The room's own Draft button on a player's row.
 *
 * When it is your turn the list's first column becomes a Draft button per
 * row, and pressing it submits the pick immediately — there is no confirm
 * step in this room. So this is the irreversible control, and it is found the
 * same careful way as the queue star: scoped to that player's row, and null
 * rather than a guess. */
export function findDraftButton(root, playerName, { player = null } = {}) {
  const isDraft = (el) => {
    if (isInsideOwnOverlay(el)) return false;
    const text = (el.textContent || "").trim();
    const label = el.getAttribute("aria-label") || "";
    return /^draft$/i.test(text) || /^draft\b/i.test(label);
  };

  // Same reasoning as the star: his name is in the feed and the queue panel
  // too, and only one of its occurrences has a Draft button beside it.
  for (const el of nameOccurrences(root, playerName)) {
    const row = el.closest?.("tr, [role='row']");
    if (row) {
      for (const candidate of row.querySelectorAll(CLICKABLE_SELECTOR)) {
        if (isDraft(candidate)) return candidate;
      }
      continue;
    }

    /* No table row: he is in the queue panel, where entries are plain divs.
     * Queued players are pulled out of the available list, so for anyone in
     * the queue this is the only Draft button that exists — and without this
     * the panel reported "no Draft button on his row" for the very player it
     * had queued itself. Bounded walk, so it stays within one entry. */
    let scope = el;
    for (let depth = 0; depth < 4 && scope.parentElement; depth++) {
      const parent = scope.parentElement;
      if ((parent.textContent || "").length > 200) break;
      scope = parent;
      for (const candidate of scope.querySelectorAll(CLICKABLE_SELECTOR)) {
        if (isDraft(candidate)) return candidate;
      }
    }
  }
  return null;
}

/* Is this player shown as unavailable on the page itself?
 *
 * Designations come from the imported pool, and a board imported before that
 * existed — or never imported at all — carries none. The room prints the tag
 * on the row regardless, so read it there too: an NA player reached the queue
 * of a live draft because the board it came from had no statuses in it. */
const OUT_TAGS = /^(IR|IR-R|PUP|PUP-R|NFI|NFI-R|SUSP|NA|O|CEL|DNR)$|(?<!\w)(IR-R|PUP-R|NFI-R|SUSP)(?!\w)/i;

export function looksUnavailableOnPage(root, playerName) {
  const doc = root.ownerDocument || root;
  const forms = [playerName, ...abbrevForms(playerName)];
  for (const row of doc.querySelectorAll("tr, [role='row']")) {
    const text = row.textContent || "";
    if (text.length > 400) continue;
    if (!textMentions(text, forms)) continue;

    /* Cell by cell, and by innerText, because textContent runs the cells
     * together: a row reads "J. ReedNAWRCar", and a word-boundary search for
     * NA then fails against the letters either side of it. An NA player was
     * queued twice on the strength of that. */
    for (const cell of row.querySelectorAll("td, th, span, div, abbr")) {
      const value = (cell.textContent || "").trim();
      if (value.length <= 5 && OUT_TAGS.test(value)) return true;
    }
    return OUT_TAGS.test(row.innerText || "");
  }
  return false;
}

/* Every name-and-ADP pair the room is currently showing.
 *
 * The league player list has no ADP column, so the board falls back to list
 * order — which orders players correctly but says nothing about where they
 * actually go. The draft room does have the column, and the sweep already
 * visits every row, so the real number costs one more read per row.
 *
 * Names come back abbreviated, as the room writes them; the caller resolves
 * them against the board the same way it resolves everything else. */
/* Every name-and-projection pair the room shows.
 *
 * The spec that asked for VORP and tier cliffs assumed a projections API and
 * an API key. The draft room prints a "Proj Pts" column on every row, and the
 * sweep already walks every row to read ADP, so the number costs one more
 * read and no provider at all. */
export function readRoomProjections(root) {
  return readNumericColumn(root, /^proj\s*pts$/i);
}

/* Every name-and-ADP pair the room is currently showing. */
export function readRoomAdp(root) {
  return readNumericColumn(root, /^adp$/i);
}

function readNumericColumn(root, headerPattern) {
  const doc = root.ownerDocument || root;
  const out = new Map();
  for (const table of doc.querySelectorAll("table")) {
    const headerRows = [...table.querySelectorAll("thead tr")];
    const headers = headerRows.length ? [...headerRows[headerRows.length - 1].children] : [];
    const adpCol = headers.findIndex((th) => headerPattern.test((th.textContent || "").trim()));
    if (adpCol < 0) continue;

    for (const row of table.querySelectorAll("tbody tr")) {
      const nameEl = row.querySelector(".ysf-player-name a") || row.querySelector("a");
      const label = (nameEl?.textContent || "").trim();
      const abbrev = label || (row.textContent || "").match(ABBREV_LABEL)?.[0];
      if (!abbrev) continue;
      const value = Number((row.children[adpCol]?.textContent || "").trim());
      if (Number.isFinite(value) && value > 0) out.set(abbrev, value);
    }
  }
  return out;
}

/* Does this row's text mention the player?
 *
 * Written out rather than done with a lookahead, because the obvious
 * expression is wrong in a way that reads as correct: (?![a-z]) inside a
 * case-insensitive regex also rejects capitals, so it turned away the very
 * rows it was meant to allow. The trailing character is checked here, case
 * intact — a capital may follow, since textContent runs cells together into
 * "J. ReedNAWRCar", but a lowercase letter may not, or "Reeder" would match.
 */
/* How many times a form is mentioned, under the same rule textMentions uses.
 * Counting with a word-boundary regex disagreed with the test that follows
 * it, so a row could be rejected as "two players" and then not confirmed for
 * either of them. */
/* Does this element show exactly this value — a team or a position — in one
 * of its cells, or spelled out cleanly in its text? */
function showsValue(el, required) {
  const wanted = required.trim().toUpperCase();
  for (const cell of el.querySelectorAll?.("td, th, span, abbr, div") || []) {
    if ((cell.textContent || "").trim().toUpperCase() === wanted) return true;
  }
  return textMentions(el.textContent || "", [required]);
}

function countMentions(text, form) {
  let n = 0;
  const re = new RegExp(`(?<!\\w)${escapeRegExp(form)}`, "gi");
  for (const match of text.matchAll(re)) {
    const next = text[match.index + match[0].length];
    if (!next || !/[a-z]/.test(next)) n++;
  }
  return n;
}

function textMentions(text, forms) {
  for (const form of forms) {
    const re = new RegExp(`(?<!\\w)${escapeRegExp(form)}`, "gi");
    for (const match of text.matchAll(re)) {
      const next = text[match.index + match[0].length];
      if (!next || !/[a-z]/.test(next)) return true;
    }
  }
  return false;
}

/* Every name-and-designation pair the room is showing.
 *
 * Guards that ask "is this one player out?" have failed three times, each by
 * treating a player it could not see as fine. Reading the whole room instead
 * puts the designations on the board itself, where the engine drops them from
 * consideration — so no path can draft them, rather than every path needing
 * its own check. */
/* An initial and a surname, stopping at the next capital. Cells run together
 * in textContent, so a greedy surname swallows the columns after it and
 * "J. Reed" becomes "J. ReedNAWRCar". Handles the room's two spellings: title
 * case in the list, upper case in the pick feed. */
const ABBREV_LABEL = /[A-Za-z]\.\s?(?:[A-Z][a-z'\u2019-]+|[A-Z]{2,})/;

export function readRoomStatuses(root) {
  const doc = root.ownerDocument || root;
  const out = new Map();
  for (const row of doc.querySelectorAll("tbody tr")) {
    /* The players page links the name; the draft room prints it in a span.
     * Requiring a link would have read nothing at all in the one place this
     * matters. */
    const nameEl = row.querySelector(".ysf-player-name a") || row.querySelector("a");
    const label = (nameEl?.textContent || "").trim() ||
      ((row.querySelector(".ysf-player-name") || row).textContent || "")
        .match(ABBREV_LABEL)?.[0] || "";
    if (!label) continue;
    for (const cell of row.querySelectorAll("td, span, abbr, div")) {
      const value = (cell.textContent || "").trim();
      if (value.length <= 5 && OUT_TAGS.test(value)) {
        out.set(label, value.toUpperCase());
        break;
      }
    }
  }
  return out;
}

/* Does the room show this player with no average draft position?
 *
 * The draft room has an ADP column even though the league player list does
 * not, so this is the one place the number can be read reliably. Yahoo prints
 * "-" for a player nobody drafts anywhere; queueing one spends a pick on a
 * name that never appears on another roster in the league. */
export function rowShowsNoAdp(root, playerName) {
  const doc = root.ownerDocument || root;
  const forms = [playerName, ...abbrevForms(playerName)];


  for (const table of doc.querySelectorAll("table")) {
    const headerRows = [...table.querySelectorAll("thead tr")];
    const headers = headerRows.length ? [...headerRows[headerRows.length - 1].children] : [];
    const adpCol = headers.findIndex((th) => /^adp$/i.test((th.textContent || "").trim()));
    if (adpCol < 0) continue;

    for (const row of table.querySelectorAll("tbody tr")) {
      const text = row.textContent || "";
      if (text.length > 400) continue;
      if (!textMentions(text, forms)) continue;
      const cell = (row.children[adpCol]?.textContent || "").trim();
      return cell === "-" || cell === "" || cell === "\u2014";
    }
  }

  /* No row in the list means he is in the queue, where entries are divs and
   * carry their own "ADP: -" text. That is exactly where this mattered: a
   * player with no ADP was queued, had no row left to inspect, and this
   * returned "fine" because it could not see him. */
  for (const entry of doc.querySelectorAll("li, div")) {
    const text = entry.textContent || "";
    if (text.length > 160) continue;
    // Exactly one, so this is a single entry rather than the panel around
    // them: a wrapper holding several would let one player's missing ADP be
    // read as another's.
    if ((text.match(/ADP:/gi) || []).length !== 1) continue;
    if (!textMentions(text, forms)) continue;
    return /ADP:\s*[-\u2014]?\s*$/i.test(text.trim()) || /ADP:\s*[-\u2014](?!\d)/i.test(text);
  }
  return false;
}

/* The control that takes a player back out of the room's queue.
 *
 * Queued players are pulled out of the available list, so their row — and its
 * star — is gone; the only handle left is in the queue panel itself, where
 * each entry carries a filled star. Everything else here refuses to click a
 * filled star precisely because it removes; this is the one place that is the
 * intent. */
export function findQueueRemove(root, playerName) {
  const doc = root.ownerDocument || root;
  const panel = [...doc.querySelectorAll("div, section, aside")].find((el) => {
    const text = el.textContent || "";
    return /Autodraft will pick from queue/i.test(text) && text.length < 2000;
  });
  if (!panel) return null;

  const forms = [playerName, ...abbrevForms(playerName)];
  const res = forms.map((f) => new RegExp(`(?<!\\w)${escapeRegExp(f)}(?!\\w)`, "i"));
  for (const el of panel.querySelectorAll("li, div, tr")) {
    const text = el.textContent || "";
    if (text.length > 120) continue; // a whole panel, not one entry
    if (!res.some((re) => re.test(text))) continue;
    const star = el.querySelector('[data-icon*="star" i]');
    if (star) return star.closest(CLICKABLE_SELECTOR) || star.parentElement;
  }
  return null;
}

/* The player list scrolls inside its own container and renders only what's
 * visible, so a single read of the page sees a window of maybe fifteen rows
 * out of two hundred. Finding that container is what makes it possible to
 * walk the whole list instead of sampling it. Chosen by content rather than
 * by class name: the scrollable element holding the most player-shaped text. */
export function findListScroller(root) {
  const doc = root.ownerDocument || root;
  /* No leading word-boundary here, deliberately: adjacent rows concatenate in
   * textContent ("...RB DETB. Robinson"), and a boundary would score a list of
   * sixty players as one. This only ranks candidate containers — the strict
   * matcher still does the real work. */
  const nameLike = /[A-Za-z]\.\s?[A-Za-z][A-Za-z'\u2019-]+/g;
  let best = null;
  let bestScore = 0;
  for (const el of doc.querySelectorAll("div, ul, section, main, table, tbody")) {
    if (isInsideOwnOverlay(el)) continue;
    if (el.scrollHeight <= el.clientHeight + 100) continue;
    const overflow = doc.defaultView.getComputedStyle(el).overflowY;
    if (overflow !== "auto" && overflow !== "scroll") continue;
    const score = ((el.textContent || "").match(nameLike) || []).length;
    if (score > bestScore) {
      bestScore = score;
      best = el;
    }
  }
  return bestScore >= 3 ? best : null;
}

/** Find a "confirm/submit" style button near the top of the page — used
 * after selecting a player, when a draft room shows a confirmation step.
 * Matches short, exact-ish button text against configured phrases rather
 * than a substring search, since "draft" as a substring would also match
 * unrelated page chrome ("Mock Draft Lobby", nav links, etc). */
export function findConfirmClickTarget(root, phrases) {
  const candidates = root.querySelectorAll(CLICKABLE_SELECTOR);
  const wanted = (phrases || [])
    .map((p) => normalizeText(p))
    .filter(Boolean);
  const normalizedDefaults = DEFAULT_CONFIRM_PHRASES.map(normalizeText);
  const useDefaults = wanted.length === 0;
  const wantedSet = new Set(useDefaults ? normalizedDefaults : wanted);

  for (const el of candidates) {
    if (isInsideOwnOverlay(el)) continue;
    const text = normalizeText(el.textContent || "");
    if (!text || text.length > 40) continue;
    if (wantedSet.has(text)) return el;
  }
  return null;
}

export const DEFAULT_CONFIRM_PHRASES = ["draft", "confirm pick", "confirm", "submit pick"];

/** Temporary visual highlight so a human can see what the extension found
 * before it acts (or, in confirm-required mode, before they click it
 * themselves). Self-removes so it never permanently alters Yahoo's page. */
export function highlightElement(el, durationMs = 5000) {
  if (!el) return;
  const prevOutline = el.style.outline;
  const prevOffset = el.style.outlineOffset;
  el.style.outline = "3px solid #1d4ed8";
  el.style.outlineOffset = "2px";
  el.scrollIntoView?.({ block: "center", behavior: "smooth" });
  setTimeout(() => {
    el.style.outline = prevOutline;
    el.style.outlineOffset = prevOffset;
  }, durationMs);
}

export function clickElement(el) {
  el?.click?.();
}
