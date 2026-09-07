/*
 * When may a sweep of the room's player list conclude that a player it did
 * not see has been drafted?
 *
 * This lived twice in the overlay, both times as a flat count of rows, and
 * both copies were wrong in the same way. A room showing its queue or results
 * tab renders a short list: the sweep reaches the bottom of that list quite
 * legitimately, and sixty rows out of two hundred and seventy-five reads as
 * the whole board. One draft marked seven available running backs drafted on
 * that reasoning — Allgeier, Bigsby, Coleman and Spears among them — and the
 * next fuller sweep reported seventy-three players put back. The engine spent
 * those rounds choosing from a pool with its running backs missing, and the
 * roster finished with two.
 *
 * Seeing a row is proof. Not seeing one is only ever an inference, so it
 * needs three things to agree: the sweep reached the end of the list, it saw
 * nearly every player the board still has available, and it is within reach
 * of the fullest view this page has managed.
 */

/* Below this, no proportion is convincing: a handful of rows can be 90% of a
 * board that is itself wrong. */
export const MIN_ROWS_TO_TRUST = 60;

/* Marking needs most of the board. Freeing needs far less, because freeing
 * only ever touches players the sweep actually saw. */
export const MARK_FRACTION = 0.9;
export const FREE_FRACTION = 0.5;

/* And within reach of the best view yet, which catches a room that renders
 * consistently but partially. */
export const BEST_FRACTION = 0.95;

/**
 * @param {number} seen       players from the board this sweep read
 * @param {boolean} reachedEnd whether it scrolled to the bottom of the list
 * @param {number} expected   players the board still believes are available
 * @param {number} best       the fullest sweep this page has managed so far
 * @returns {{mark: boolean, free: boolean, best: number}}
 */
export function sweepTrust(seen, reachedEnd, expected, best = 0) {
  const bestSeen = Math.max(best, seen);
  const free = seen >= Math.max(MIN_ROWS_TO_TRUST, Math.round(expected * FREE_FRACTION));
  const mark =
    Boolean(reachedEnd) &&
    seen >= Math.max(MIN_ROWS_TO_TRUST, Math.round(expected * MARK_FRACTION)) &&
    seen >= bestSeen * BEST_FRACTION;
  return { mark, free, best: bestSeen };
}
