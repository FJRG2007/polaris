/**
 * Keeping the session image current.
 *
 * `SESSION_IMAGE` is a floating tag (`node:24`), and compose's default pull
 * policy only fetches an image that is missing - so a machine that pulled it once
 * kept that Node for good, CVEs included (one box was found running a copy seven
 * weeks old). A session start now asks the registry again once a day; every other
 * start uses the copy on the machine. A pull that fails (the registry is down,
 * the machine is offline) never stops a session: it starts again on the cached
 * image, and the next start tries the pull again.
 *
 * Server-only. The day is kept per process, which is enough: a restart costs one
 * extra pull at most.
 */

import type { ComposePullPolicy } from "@polaris/deploy";

export const SESSION_IMAGE_REFRESH_MS = 24 * 60 * 60_000;

/** "always" when the image was not refreshed within the window, else "missing". */
export function sessionPullPolicy(lastPulledAt: number | null, now: number): ComposePullPolicy {
    return lastPulledAt !== null && now - lastPulledAt < SESSION_IMAGE_REFRESH_MS
        ? "missing"
        : "always";
}

let lastPulledAt: number | null = null;

/**
 * Bring a session container up with `up`, asking for a fresh image when one is
 * due and falling back to the cached image when that pull fails.
 */
export async function upWithFreshImage(
    up: (pullPolicy: ComposePullPolicy) => Promise<void>,
    now: () => number = Date.now
): Promise<void> {
    // On backup access the data saver keeps the cached image: a refresh is a pull
    // of the whole image over the backup line. One that is missing still pulls.
    const saver = await import("@/lib/backup-access")
        .then((m) => m.dataSaverActive())
        .catch(() => false);
    const policy = saver ? "missing" : sessionPullPolicy(lastPulledAt, now());
    if (policy === "missing") return up("missing");
    try {
        await up("always");
        lastPulledAt = now();
    } catch (caught) {
        console.warn(
            "polaris: the session image could not be refreshed, using the cached one:",
            caught
        );
        await up("missing");
    }
}

/** For tests: forget when the image was last refreshed. */
export function resetSessionImageRefresh(): void {
    lastPulledAt = null;
}
