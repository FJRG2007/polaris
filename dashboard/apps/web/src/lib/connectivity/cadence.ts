/**
 * How often the address watcher looks, in one place, because three things depend
 * on it: the watcher's own timer, the tracker deciding whether a gap between two
 * passes means Polaris was not watching, and the screen saying how precisely a
 * start or an end is known.
 */

/** The usual pace. Slow on purpose: a handful of addresses, and an operator does
 *  not need to hear about a blip on their own dashboard's domain. */
export const WATCH_INTERVAL_MS = Number(process.env.POLARIS_ADDRESS_WATCH_MS) || 10 * 60_000;

/** The pace while something is down, and for the merge window after it comes back:
 *  close enough to measure an outage's end to the half-minute, never faster than
 *  the usual pace. */
export const CLOSE_WATCH_MS = Math.min(30_000, WATCH_INTERVAL_MS);

/**
 * A gap between two passes longer than this means nobody was watching - Polaris
 * was stopped, or the box was off. Two usual intervals plus the time a pass full
 * of timeouts takes, so a redeploy in the middle of an outage is never mistaken
 * for one.
 */
export const STALE_AFTER_MS = 2 * WATCH_INTERVAL_MS + 2 * 60_000;
