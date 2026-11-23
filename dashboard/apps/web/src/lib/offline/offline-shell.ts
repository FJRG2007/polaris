/**
 * The pages the service worker keeps so Polaris opens with no network
 * (`public/sw.js`), seen from the page.
 *
 * The worker keeps every page of the app that loaded, and it cannot tell which
 * apps this account keeps behind its PIN. So the page, which can, drops the kept
 * pages of a locked app whenever the locks are known or change: a locked app is
 * never readable from this device without the server that asks for the PIN.
 */

import { lockedAppForPath } from "@/lib/app-locks";

/** The cache the worker keeps pages in. Deleted whole on sign-out (`account-switch`). */
export const SHELL_CACHE = "polaris-shell-v1";

/** Of the kept paths, the ones that belong to a locked app. Pure. */
export function lockedKeptPaths(paths: readonly string[], locked: readonly string[]): string[] {
    return paths.filter((path) => lockedAppForPath(path, locked) !== null);
}

/** Deletes the kept pages of every locked app. Never throws: no cache, nothing kept. */
export async function forgetLockedPages(locked: readonly string[]): Promise<void> {
    if (locked.length === 0 || typeof caches === "undefined") return;
    try {
        const cache = await caches.open(SHELL_CACHE);
        const keys = await cache.keys();
        const doomed = new Set(lockedKeptPaths(keys.map((key) => new URL(key.url).pathname), locked));
        await Promise.all(keys.filter((key) => doomed.has(new URL(key.url).pathname)).map((key) => cache.delete(key)));
    } catch {
        // Storage refused (a private window, an insecure origin): nothing was kept.
    }
}
