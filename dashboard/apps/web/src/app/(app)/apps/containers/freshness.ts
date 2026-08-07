/**
 * How old a reading is, in words, for every screen that shows one.
 *
 * Usage is sampled behind the request rather than in front of it, and a revisit
 * paints the last sample before the fresh one lands, so what is on screen is
 * rarely this instant's. That is only honest if the screen says so once the
 * number has aged, which is what this is for. Lives with the Containers screens
 * because that is where it started; the servers and deploy panels read it too.
 */

/** A gap in words: "3s", "2m", "1h". Sub-second gaps read as "0s" rather than
 *  as a fraction nobody needs. */
export function formatAge(ms: number): string {
    const seconds = Math.max(0, Math.round(ms / 1000));
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.round(seconds / 60);
    return minutes < 60 ? `${minutes}m` : `${Math.round(minutes / 60)}h`;
}

/** Past this, a reading is old enough that showing it without saying so would
 *  mislead. Under it, the numbers are as live as a five-second poll gets. */
export const STALE_AFTER_MS = 12_000;
