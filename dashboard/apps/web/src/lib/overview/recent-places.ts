/**
 * Where this browser has been in Polaris.
 *
 * Kept in the browser rather than on the account, and that is the whole design:
 * a navigation happens every few seconds, and writing a row for each of them
 * would put a database write behind every click in the dashboard to fill one
 * card. What is lost is that the list does not follow somebody to another
 * machine - which, for "take me back to where I just was", is no loss at all.
 *
 * Anything read back out is validated first. It is a string another tab, an
 * extension or an older build of Polaris can write, and it ends up as a link.
 */

import * as core from "@polaris/core";

const STORE_KEY = "polaris.overview.recent";

function readStore(): core.RecentPlace[] {
    if (typeof window === "undefined") return [];
    let raw: string | null = null;
    try {
        raw = window.localStorage.getItem(STORE_KEY);
    } catch {
        // Storage can be denied outright (private mode, blocked cookies). The
        // dashboard still works; the card is simply empty.
        return [];
    }
    if (!raw) return [];

    try {
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        const places: core.RecentPlace[] = [];
        for (const item of parsed) {
            const place = core.recentPlaceSchema.safeParse(item);
            const visitedAt = (item as { visitedAt?: unknown })?.visitedAt;
            if (!place.success || typeof visitedAt !== "string") continue;
            places.push({ ...place.data, visitedAt });
        }
        return core.mergeRecentPlaces(places);
    } catch {
        return [];
    }
}

function writeStore(places: readonly core.RecentPlace[]): void {
    if (typeof window === "undefined") return;
    try {
        window.localStorage.setItem(STORE_KEY, JSON.stringify(places));
    } catch {
        // A full or refused storage costs the history, not the navigation.
    }
}

export function readRecentPlaces(): core.RecentPlace[] {
    return readStore();
}

/** Record one visit and return the list as it now stands. */
export function rememberPlace(input: core.RecentPlaceInput): core.RecentPlace[] {
    const place: core.RecentPlace = { ...input, visitedAt: new Date().toISOString() };
    const merged = core.mergeRecentPlaces([place], readStore());
    writeStore(merged);
    return merged;
}

export function forgetPlace(href: string): core.RecentPlace[] {
    const kept = readStore().filter((place) => place.href !== href);
    writeStore(kept);
    return kept;
}

export function clearRecentPlaces(): void {
    writeStore([]);
}
