/**
 * The search vocabulary: what can be searched, and what is remembered.
 *
 * A scope is one kind of thing the palette can be pointed at, and the split
 * below is the whole reason the commands exist. Local scopes are answered from
 * the index the palette already holds, so narrowing to one costs nothing.
 * Remote scopes are a query against the database - tasks, pages, notes, people -
 * and those only run once somebody has said which of them they meant, rather
 * than every kind at once on every keystroke.
 *
 * Recent searches are the same shape on both sides: the browser keeps them so
 * the panel paints instantly, the account keeps them so they follow the person
 * to another device, and one schema means the two can be merged without either
 * trusting what the other stored.
 */

import { z } from "zod";

export const LOCAL_SEARCH_SCOPES = ["projects", "services", "databases", "servers", "runners", "apps"] as const;

export const REMOTE_SEARCH_SCOPES = ["tasks", "docs", "notes", "users"] as const;

export const SEARCH_SCOPES = [...LOCAL_SEARCH_SCOPES, ...REMOTE_SEARCH_SCOPES] as const;

export type LocalSearchScope = (typeof LOCAL_SEARCH_SCOPES)[number];
export type RemoteSearchScope = (typeof REMOTE_SEARCH_SCOPES)[number];
export type SearchScope = (typeof SEARCH_SCOPES)[number];

export function isRemoteSearchScope(scope: SearchScope): scope is RemoteSearchScope {
    return (REMOTE_SEARCH_SCOPES as readonly string[]).includes(scope);
}

/** Long enough for a pasted task title, short enough to still be a search. */
export const SEARCH_TERM_MAX = 120;

/** Recent searches kept per person, on either side. Past this the list stops
 *  being the handful somebody recognizes at a glance. */
export const MAX_RECENT_SEARCHES = 20;

/**
 * What one search asks the server for. The term may be empty: a command with
 * nothing typed after it offers what was touched most recently, which is one
 * query and the answer to "what was I working on".
 */
export const searchLookupSchema = z.object({
    scope: z.enum(REMOTE_SEARCH_SCOPES),
    query: z.string().trim().max(SEARCH_TERM_MAX).default("")
});

export type SearchLookupInput = z.infer<typeof searchLookupSchema>;

/**
 * A path inside this Polaris.
 *
 * History is replayed as somewhere to navigate, and it arrives from the
 * browser's own storage or from a row written long ago - neither of which is
 * evidence of anything. Anchoring it to a single leading slash keeps a stored
 * `javascript:` or `//evil.example` from ever becoming a destination.
 */
export const internalPath = z
    .string()
    .max(512)
    .refine((value) => value.startsWith("/") && !value.startsWith("//"), "That is not a path inside Polaris");

export const recentSearchSchema = z.object({
    /** `result` is something that was opened, `query` the words that were run. */
    kind: z.enum(["result", "query"]),
    /** The command it was made under, or null for an unscoped search. */
    scope: z.enum(SEARCH_SCOPES).nullable().default(null),
    term: z.string().trim().max(SEARCH_TERM_MAX).default(""),
    label: z.string().trim().min(1).max(200),
    /** Where opening it goes. A remembered query has nowhere to go: it is put
     *  back in the field and run again. */
    href: internalPath.nullable().default(null)
});

export type RecentSearchInput = z.infer<typeof recentSearchSchema>;

export interface RecentSearch extends RecentSearchInput {
    /** When it was last used, ISO 8601. Two stores are merged by this. */
    readonly usedAt: string;
}

/**
 * What makes two entries the same search.
 *
 * Opening the same task twice is one memory with a newer timestamp, not two
 * rows; and a query is remembered by the words rather than the casing, so
 * "Orphion" does not sit under "orphion" in the same list.
 */
export function recentSearchKey(entry: Pick<RecentSearch, "kind" | "scope" | "term" | "href">): string {
    const target = entry.kind === "result" ? (entry.href ?? "") : entry.term.toLowerCase();
    return `${entry.kind}:${entry.scope ?? ""}:${target}`;
}

/** Newest first, capped, one entry per key. */
export function mergeRecentSearches(...lists: readonly (readonly RecentSearch[])[]): RecentSearch[] {
    const byKey = new Map<string, RecentSearch>();
    for (const entry of lists.flat()) {
        const key = recentSearchKey(entry);
        const held = byKey.get(key);
        if (!held || held.usedAt < entry.usedAt) byKey.set(key, entry);
    }
    return [...byKey.values()]
        .sort((left, right) => right.usedAt.localeCompare(left.usedAt))
        .slice(0, MAX_RECENT_SEARCHES);
}
