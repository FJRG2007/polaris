/**
 * Finding one key in a list of them.
 *
 * A key list starts as three rows and becomes fourteen without anybody deciding
 * to let it: one per script, one per machine, two from an afternoon of trying
 * something, and a couple nobody remembers making. At that size the list stops
 * answering the questions it is opened for - which of these is still being used,
 * which one expires this month, which one is the one wired into production -
 * and the honest fix is not a longer page but the four questions themselves.
 *
 * All of it is worked out here, over the rows the screen already has, so
 * narrowing the list is instant and costs the server nothing. Pure on purpose:
 * the rules that decide whether a key is expired, expiring or merely old are the
 * part that can be wrong in a way nobody notices, and they are checkable without
 * a browser or a database.
 */

import { API_KEY_PREFIX } from "@polaris/core";
import type { ApiKeyView } from "@polaris/auth";

/** What a key's state actually is, whatever the row says about it. */
export type KeyLifecycle = "active" | "expired" | "revoked";

/** How soon an expiry counts as worth warning about. A week is long enough to
 *  do something about it and short enough that it is not the whole list. */
export const EXPIRING_SOON_DAYS = 7;

export function lifecycleOf(key: ApiKeyView, now = Date.now()): KeyLifecycle {
    if (key.revokedAt) return "revoked";
    if (key.expiresAt && new Date(key.expiresAt).getTime() <= now) return "expired";
    return "active";
}

/** Whether a key is about to stop working. Expired is not "soon" - it has
 *  already happened, and it is its own state. */
export function expiringSoon(key: ApiKeyView, now = Date.now()): boolean {
    if (!key.expiresAt || lifecycleOf(key, now) !== "active") return false;
    return new Date(key.expiresAt).getTime() - now <= EXPIRING_SOON_DAYS * 24 * 60 * 60 * 1000;
}

/**
 * The key as it can safely be shown, and no more of it than that.
 *
 * What the column is for is answering "is this row the key my deploy is using",
 * and the last few characters answer it on their own - they are what somebody
 * compares against the value sitting in their password manager. The eight
 * random characters of the public half identify the row to Polaris and nothing
 * at all to a person reading a table, so they are left out: a column of
 * `plk_IpZSCeDj...um90` is a column of noise with the answer at the end of it.
 * Searching still matches them, because a key found in a log is pasted whole.
 *
 * A key issued before the tail was kept has nothing at the end to show, so it
 * shows what it has rather than a marker that identifies every key equally.
 */
export function maskedKey(key: ApiKeyView): string {
    return key.tail ? `${API_KEY_PREFIX}_...${key.tail}` : `${key.prefix}...`;
}

export const EXPIRY_FILTERS = ["all", "never", "soon", "expired"] as const;
export type ExpiryFilter = (typeof EXPIRY_FILTERS)[number];

export const KEY_SORTS = ["created-desc", "created-asc", "used-desc", "usage-desc", "name-asc"] as const;
export type KeySort = (typeof KEY_SORTS)[number];

export const KEY_SORT_LABELS: Record<KeySort, string> = {
    "created-desc": "Created (newest)",
    "created-asc": "Created (oldest)",
    "used-desc": "Last used",
    "usage-desc": "Calls today",
    "name-asc": "Name"
};

export const EXPIRY_FILTER_LABELS: Record<ExpiryFilter, string> = {
    all: "All",
    never: "Never expires",
    soon: `Expiring in ${EXPIRING_SOON_DAYS} days`,
    expired: "Expired"
};

/** What is being asked of the list. `all` is the value that asks nothing, so a
 *  filter nobody touched is not a filter. */
export interface KeyFilters {
    search: string;
    /** A project id, "none" for the keys that belong to no app, or "all". */
    app: string;
    /** An environment, or "all". */
    environment: string;
    expiry: ExpiryFilter;
    sort: KeySort;
}

export const NO_FILTERS: KeyFilters = {
    search: "",
    app: "all",
    environment: "all",
    expiry: "all",
    sort: "created-desc"
};

/** The apps that actually appear in this list, for the picker to offer. Taken
 *  from the keys rather than from every project the account owns: a filter that
 *  offers forty apps and finds keys in two is a filter nobody uses twice. */
export function appsInKeys(keys: readonly ApiKeyView[]): { id: string; name: string }[] {
    const found = new Map<string, string>();
    for (const key of keys) {
        if (key.projectId) found.set(key.projectId, key.projectName ?? "App");
    }
    return [...found].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The list, narrowed and ordered.
 *
 * Search covers the name and the visible halves of the key itself, because
 * "which row is `plk_a3f...`" is exactly the question somebody arrives with when
 * they have found a key in a log and want to know what it is - and a whole key
 * pasted in counts too, which is what somebody does when they have found the
 * value in a config file and want to know what it can reach. That one is matched
 * the other way round: the row is inside what was pasted rather than the other
 * way about.
 */
export function filterKeys(
    keys: readonly ApiKeyView[],
    filters: KeyFilters,
    now = Date.now()
): ApiKeyView[] {
    const needle = filters.search.trim().toLowerCase();
    const found = keys.filter((key) => {
        if (needle) {
            const haystack =
                `${key.name} ${key.description} ${key.prefix} ${key.tail ?? ""}`.toLowerCase();
            const pasted = needle.startsWith(key.prefix.toLowerCase());
            if (!pasted && !haystack.includes(needle)) return false;
        }
        if (filters.app === "none" && key.projectId) return false;
        if (filters.app !== "all" && filters.app !== "none" && key.projectId !== filters.app) {
            return false;
        }
        if (filters.environment !== "all" && key.environment !== filters.environment) return false;

        switch (filters.expiry) {
            case "never":
                return key.expiresAt === null;
            case "soon":
                return expiringSoon(key, now);
            case "expired":
                return lifecycleOf(key, now) === "expired";
            default:
                return true;
        }
    });

    return found.sort((a, b) => {
        switch (filters.sort) {
            case "created-asc":
                return a.createdAt.localeCompare(b.createdAt);
            case "name-asc":
                return a.name.localeCompare(b.name);
            case "usage-desc":
                return b.usedToday - a.usedToday || b.createdAt.localeCompare(a.createdAt);
            case "used-desc":
                // A key that has never been used sorts last rather than first: an
                // empty value is not "used a very long time ago".
                return (b.lastUsedAt ?? "").localeCompare(a.lastUsedAt ?? "");
            default:
                return b.createdAt.localeCompare(a.createdAt);
        }
    });
}
