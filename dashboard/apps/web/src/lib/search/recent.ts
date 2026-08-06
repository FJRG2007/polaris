/**
 * The browser's copy of what was last searched for.
 *
 * It exists so the panel opens with something in it on the first frame, before
 * the account's own history has come back from the server - opening a search and
 * being shown an empty box for 200ms is the thing this avoids. The account copy
 * is the one that follows somebody to another machine; the two are merged, and
 * either surviving alone still works.
 *
 * Anything read back out of storage is validated first. It is a string another
 * tab, an extension or a past build of Polaris can write, and it ends up being
 * navigated to.
 */

import * as core from "@polaris/core";

const STORE_KEY = "polaris.search.recent";

function readStore(): core.RecentSearch[] {
    if (typeof window === "undefined") return [];
    let raw: string | null = null;
    try {
        raw = window.localStorage.getItem(STORE_KEY);
    } catch {
        // Storage can be denied outright (private mode, blocked cookies). The
        // search still works; it just opens without a history.
        return [];
    }
    if (!raw) return [];

    try {
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        const entries: core.RecentSearch[] = [];
        for (const item of parsed) {
            const entry = core.recentSearchSchema.safeParse(item);
            const usedAt = (item as { usedAt?: unknown })?.usedAt;
            if (!entry.success || typeof usedAt !== "string") continue;
            entries.push({ ...entry.data, usedAt });
        }
        return core.mergeRecentSearches(entries);
    } catch {
        return [];
    }
}

function writeStore(entries: readonly core.RecentSearch[]): void {
    if (typeof window === "undefined") return;
    try {
        window.localStorage.setItem(STORE_KEY, JSON.stringify(entries));
    } catch {
        // A full or refused storage costs the history, not the search.
    }
}

export function readRecentSearches(): core.RecentSearch[] {
    return readStore();
}

/** Record one search here and return the list as it now stands. */
export function rememberSearch(input: core.RecentSearchInput): core.RecentSearch[] {
    const entry: core.RecentSearch = { ...input, usedAt: new Date().toISOString() };
    const merged = core.mergeRecentSearches([entry], readStore());
    writeStore(merged);
    return merged;
}

export function forgetRecentSearch(key: string): core.RecentSearch[] {
    const kept = readStore().filter((entry) => core.recentSearchKey(entry) !== key);
    writeStore(kept);
    return kept;
}

export function clearRecentSearches(): void {
    writeStore([]);
}

/** What to draw: this browser's list and the account's, newest wins. */
export function mergeIntoStore(remote: readonly core.RecentSearch[]): core.RecentSearch[] {
    const merged = core.mergeRecentSearches(readStore(), remote);
    writeStore(merged);
    return merged;
}
