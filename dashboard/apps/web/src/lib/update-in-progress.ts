/**
 * Whether this device started an update of Polaris a moment ago.
 *
 * While an update rolls over, Polaris can stop answering for a few seconds, and
 * "can't reach Polaris" is the wrong thing to tell the person who pressed Update.
 * Settings marks the start here and clears it when the new build takes over; the
 * connection banner reads it. Kept in localStorage so every tab on the device knows,
 * and bounded in time so a mark that was never cleared stops speaking by itself.
 */

const KEY = "polaris.update.inProgress";

/** Longer than any update this device would still be waiting on. */
const MAX_AGE_MS = 20 * 60 * 1000;

export function markUpdateInProgress(at: number = Date.now()): void {
    try {
        localStorage.setItem(KEY, String(at));
    } catch {
        // Storage refused (a private window): the banner then says "unreachable",
        // which is still true.
    }
}

export function clearUpdateInProgress(): void {
    try {
        localStorage.removeItem(KEY);
    } catch {
        // As above.
    }
}

export function updateInProgress(now: number = Date.now()): boolean {
    try {
        const at = Number(localStorage.getItem(KEY));
        return Number.isFinite(at) && at > 0 && now - at < MAX_AGE_MS;
    } catch {
        return false;
    }
}
