/*
 * A ledger of things that were tried and did not work.
 *
 * Every loop in the panel is bounded inside one cycle — the queue tries eight
 * candidates, a turn skips at most four recommendations — and none of that
 * helps, because the cycle restarts every few seconds against the same board
 * and re-derives the same candidates. Bounded inner loops compose into an
 * unbounded outer one, which is how the panel spent a whole draft cycling
 * Jeanty, Smith, Olave and Williams, sweeping the entire list for each, while
 * the queue stayed empty and Yahoo autodrafted.
 *
 * Nothing was learned between cycles. This is where that goes: a target that
 * keeps failing rests for a while, and the loop moves on to one that might
 * work. Resting is deliberately temporary — most failures here are transient
 * (a row not currently mounted, a list mid-re-render), so a permanent
 * blacklist would throw away good players for the rest of a draft.
 */
export class Attempts {
  /**
   * @param {number} tries how many failures before a target rests
   * @param {number} restMs how long it rests
   * @param {() => number} now injectable clock, for tests
   */
  constructor({ tries = 3, restMs = 90_000, now = () => Date.now() } = {}) {
    this.tries = tries;
    this.restMs = restMs;
    this.now = now;
    this.entries = new Map();
  }

  /* Records a failure. Returns true when this one put the target to rest, so
   * the caller can say so once rather than on every attempt. */
  fail(key) {
    const entry = this.entries.get(key) || { misses: 0, until: 0 };
    entry.misses += 1;
    let rested = false;
    if (entry.misses >= this.tries) {
      entry.misses = 0;
      entry.until = this.now() + this.restMs;
      rested = true;
    }
    this.entries.set(key, entry);
    return rested;
  }

  /* Anything that worked is no longer suspect. */
  succeed(key) {
    this.entries.delete(key);
  }

  resting(key) {
    return (this.entries.get(key)?.until || 0) > this.now();
  }

  /* For a panel that has to explain itself. */
  restingKeys() {
    const t = this.now();
    return [...this.entries.entries()]
      .filter(([, e]) => e.until > t)
      .map(([key]) => key);
  }
}
