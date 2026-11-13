/**
 * Whether a start updates before it opens. Pure, for the tests: `index.ts` hands
 * it the first check (`updates.ts`) and the steps that touch windows and settings.
 *
 * Holding the app back has to be safe for somebody with no terminal, so every
 * way out but a working restart ends in an app that opens. A version gets one
 * start: whatever became of it, it is not tried again before opening and stays
 * with the background install and the button.
 */

import type { FirstCheck } from "./updates";

/** How long the first check may hold the app back once it has been asked: a slow
 *  answer updates in the background instead. */
export const CHECK_BEFORE_OPENING_MS = 1_500;
/** The most a start waits to learn how this copy updates (macOS checks its
 *  signature first), so that check does not eat the time of the one above. */
export const SETTLE_BEFORE_ASKING_MS = 5_000;
/** The most a start waits for an update before opening the version it has. */
export const UPDATE_BEFORE_OPENING_MS = 3 * 60_000;
/** How long a restart has to end this process. One that returned and left it
 *  running opens the app, so nobody stays on the updating window. */
export const RESTART_BEFORE_OPENING_MS = 30_000;

export interface OpeningSteps {
    /** The version a start last held the app back for, if any. */
    readonly attempted: () => string | null;
    /** Remember the version this start is holding the app back for. */
    readonly attempt: (version: string) => void;
    /** Whether something already opened the app while it was held back. */
    readonly opened: () => boolean;
    /** Show the updating window; settles when it is closed. */
    readonly showUpdating: () => Promise<void>;
    /** Restart into the installed update; false when that failed. */
    readonly restart: () => boolean;
}

/** `open`: the caller opens the app. `closed`: the updating window was closed,
 *  so nothing opens by itself. A restart that works never returns. */
export type Opening = "open" | "closed";

function after<T>(ms: number, value: T): Promise<T> {
    return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

export async function updateBeforeOpening(first: Omit<FirstCheck, "checkNow" | "downloaded">, steps: OpeningSteps): Promise<Opening> {
    await Promise.race([first.asked, after(SETTLE_BEFORE_ASKING_MS, undefined)]);
    const version = await Promise.race([first.installing, after(CHECK_BEFORE_OPENING_MS, null)]);
    if (!version || version === steps.attempted() || steps.opened()) return "open";

    try {
        steps.attempt(version);
    } catch {
        return "open";
    }
    const closed = steps.showUpdating().then(() => "closed" as const);
    const installed = first.installed.then((done) => (done ? ("installed" as const) : ("open" as const)));
    const outcome = await Promise.race([closed, installed, after(UPDATE_BEFORE_OPENING_MS, "open" as const)]);
    if (outcome !== "installed") return outcome;

    if (steps.restart()) await after(RESTART_BEFORE_OPENING_MS, undefined);
    return "open";
}
