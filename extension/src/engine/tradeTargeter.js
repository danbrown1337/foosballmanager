/*
 * Lowball trade offer generator — a faithful port of trade_targeter.py.
 *
 * Read-only by design, same as the Python original and the same principle
 * this project has held everywhere else: Yahoo's own API can't submit
 * trades, and scripting the actual sends risks looking like bot activity
 * against Yahoo's terms. This module only ever returns text describing an
 * offer — nothing here fills in or submits Yahoo's trade form.
 */

export function surplusAndDeficit(roster, config) {
  const starters = config.roster.starters;
  const counts = {};
  for (const p of roster) counts[p.pos] = (counts[p.pos] || 0) + 1;

  const surplus = [];
  const deficit = [];
  for (const pos of ["QB", "RB", "WR", "TE"]) {
    const need = (starters[pos] || 0) + (pos === "RB" || pos === "WR" ? 0.5 : 0); // flex fuzziness
    const have = counts[pos] || 0;
    if (have >= need + 2) surplus.push(pos);
    else if (have <= need) deficit.push(pos);
  }
  return { surplus, deficit };
}

/**
 * @param {string} teamName
 * @param {{name:string,pos:string}[]} roster - the rival team's roster
 * @param {{name:string,pos:string}[]} myRoster
 * @param {Map<string,{adp:number}>} adpLookup - name -> {adp}
 * @param {object} config
 * @param {number} count - max offers to return
 * @returns {string[]}
 */
export function buildOffersForTeam(teamName, roster, myRoster, adpLookup, config, count) {
  const { surplus, deficit } = surplusAndDeficit(roster, config);
  const offers = [];
  if (surplus.length === 0 || deficit.length === 0) return offers;

  // Their best player at each surplus position (lowest ADP = most valuable).
  const bestByPos = {};
  for (const p of roster) {
    const info = adpLookup.get(p.name);
    if (info) (bestByPos[p.pos] ||= []).push([info.adp, p.name]);
  }
  for (const pos of Object.keys(bestByPos)) bestByPos[pos].sort((a, b) => a[0] - b[0]);

  // Our worst player at each deficit position (highest ADP = least valuable).
  const worstMineByPos = {};
  for (const p of myRoster) {
    const info = adpLookup.get(p.name);
    if (info) (worstMineByPos[p.pos] ||= []).push([info.adp, p.name]);
  }
  for (const pos of Object.keys(worstMineByPos)) worstMineByPos[pos].sort((a, b) => b[0] - a[0]);

  let n = 0;
  for (const wantPos of surplus) {
    if (!(wantPos in bestByPos)) continue;
    for (const givePos of deficit) {
      const candidates = worstMineByPos[givePos] || [];
      if (candidates.length === 0) continue;

      const [targetAdp, targetName] = bestByPos[wantPos][0];
      const [giveAdp, giveName] = candidates[0];
      const gap = giveAdp - targetAdp;

      let verdict;
      if (gap > 40) verdict = "genuinely lopsided in your favor";
      else if (gap > 10) verdict = "a mild lowball";
      else if (gap >= 0) verdict = "close to fair value — not much of a lowball, check other options";
      else verdict = "actually favors THEM — don't send this one";
      const direction = gap >= 0 ? "in your favor" : "against you";

      offers.push(
        `  Offer ${teamName}: send them "${giveName}" (${givePos}, ADP ${giveAdp}) ` +
          `for their "${targetName}" (${wantPos}, ADP ${targetAdp}) — ` +
          `they're ${bestByPos[wantPos].length}-deep at ${wantPos} and thin at ${givePos}. ` +
          `ADP gap: ${Math.abs(gap).toFixed(1)} picks ${direction} (${verdict}).`
      );
      n += 1;
      if (n >= count) return offers; // matches the Python original: returns
      // immediately, not just breaking the inner loop — count caps the
      // total offers across every surplus/deficit pairing, not per pairing.
    }
  }
  return offers;
}
