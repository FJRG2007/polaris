/**
 * How old a reading is, in words, for the two Containers screens that show one.
 *
 * Usage is sampled behind the request rather than in front of it, so what is on
 * screen is the last sample rather than this instant's. That is only honest if
 * the screen says so when the number has aged, which is what this is for.
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
