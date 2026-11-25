/**
 * A page that failed because the network blinked, and how it gets itself back.
 *
 * The desktop app opens with the computer, often a second before Wi-Fi has
 * settled, and a laptop wakes into the same gap. A page that asks the server for
 * anything in that second throws `TypeError: Failed to fetch` (or Safari's
 * "Load failed", or Firefox's "NetworkError when attempting to fetch"), and the
 * error boundary used to answer it with "Polaris could not start this page" and
 * the words "network error" - for a failure that a second try a moment later
 * clears on its own. So the boundaries recognise this class, retry by
 * themselves with a short backoff while the page's skeleton stays up, and show a
 * card only after the retries ran out, in words about the connection rather than
 * the exception.
 *
 * Pure apart from the hook, and client-safe: the error boundaries run in the
 * browser.
 */

import { useEffect, useRef, useState } from "react";

/** What the browsers and Next say when a request never got an answer. */
const NETWORK_PATTERNS: readonly RegExp[] = [
    /failed to fetch/i,
    /^network ?error$/i,
    /networkerror when attempting/i,
    /network request failed/i,
    /^load failed$/i,
    /^fetch failed$/i,
    /internet connection appears to be offline/i,
    /err_(?:internet_disconnected|network_changed|connection_(?:reset|refused|closed|timed_out))/i,
    /failed to load resource/i
];

/**
 * Whether this failure is the request not reaching the server, as opposed to a
 * fault in the page. A failure while the browser itself reports no connection
 * counts too, whatever its wording.
 */
export function isNetworkError(
    error: { name?: string; message?: string } | null | undefined,
    online: boolean = typeof navigator === "undefined" ? true : navigator.onLine !== false
): boolean {
    if (!error) return false;
    if (!online) return true;
    if (error.name === "AbortError" || error.name === "NetworkError") return true;
    const message = (error.message ?? "").trim();
    return NETWORK_PATTERNS.some((pattern) => pattern.test(message));
}

/** The pause before each automatic retry. After the last one the card is shown. */
export const NETWORK_RETRY_DELAYS_MS: readonly number[] = [500, 1500, 4000];

/** A failure further apart than this from the previous one starts a new count,
 *  so a page that recovered and hit another blip an hour later retries again. */
const STREAK_WINDOW_MS = 30_000;

/**
 * Network failures in a row. A retry that fails mounts a fresh boundary, so the
 * count cannot live in state; module scope is per tab and dies with the page.
 * Keyed to the error object so a double-invoked effect does not count twice.
 */
let counted: unknown = null;
let streak = { count: 0, at: 0 };

/** Record one network failure and return how many came in a row, this one included. */
export function countNetworkFailure(error: unknown, now: number = Date.now()): number {
    if (counted === error) return streak.count;
    counted = error;
    streak = now - streak.at < STREAK_WINDOW_MS ? { count: streak.count + 1, at: now } : { count: 1, at: now };
    return streak.count;
}

/** Forget the streak, for a retry the reader asked for or the connection coming back. */
export function resetNetworkStreak(): void {
    streak = { count: 0, at: 0 };
}

/**
 * Drive the automatic retries for a boundary showing `error`.
 *
 * Returns `"retrying"` while a retry is still due - the boundary draws the
 * page's skeleton - and `"offline"` once they ran out, when it draws the card.
 * From then on the connection coming back (`online`) or the window being
 * looked at again (`focus`) retries once more by itself. Errors of any other
 * kind return `"other"` and nothing is scheduled.
 */
export function useNetworkRetry(error: Error, retry: () => void): "retrying" | "offline" | "other" {
    const network = isNetworkError(error);
    const [attempt, setAttempt] = useState(0);
    const retryRef = useRef(retry);
    retryRef.current = retry;

    useEffect(() => {
        if (network) setAttempt(countNetworkFailure(error));
    }, [error, network]);

    const exhausted = attempt > NETWORK_RETRY_DELAYS_MS.length;

    useEffect(() => {
        if (!network || attempt === 0) return;
        if (!exhausted) {
            const timer = window.setTimeout(() => retryRef.current(), NETWORK_RETRY_DELAYS_MS[attempt - 1]);
            return () => window.clearTimeout(timer);
        }
        const again = () => {
            resetNetworkStreak();
            retryRef.current();
        };
        window.addEventListener("online", again);
        window.addEventListener("focus", again);
        return () => {
            window.removeEventListener("online", again);
            window.removeEventListener("focus", again);
        };
    }, [network, attempt, exhausted]);

    if (!network) return "other";
    return exhausted ? "offline" : "retrying";
}
