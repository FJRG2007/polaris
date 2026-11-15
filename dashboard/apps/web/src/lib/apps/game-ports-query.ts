/**
 * The query the Ports page reads game servers with: a search, a state filter, a
 * sort and a keyset cursor, never an offset.
 *
 * A hosting deployment runs far more servers than a page can hold, so the list
 * is read one bounded page at a time in the order an index already keeps, and
 * the cursor names the last row shown rather than a row count to skip - an
 * offset into tens of millions of rows is a scan of all of them.
 *
 * Pure: the route parses with it and the card builds its URL with it.
 */

import { z } from "zod";

export const GAME_PORTS_PAGE_MAX = 100;
export const GAME_PORTS_PAGE_DEFAULT = 25;
export const GAME_PORTS_SEARCH_MAX = 100;

export const GAME_PORTS_STATUSES = ["all", "running", "stopped"] as const;
export const GAME_PORTS_SORTS = ["name", "newest"] as const;

export type GamePortsStatus = (typeof GAME_PORTS_STATUSES)[number];
export type GamePortsSort = (typeof GAME_PORTS_SORTS)[number];

/** Where the next page starts: the sort key and id of the last row shown. */
export interface GamePortsCursor {
    readonly key: string;
    readonly id: string;
}

export interface GamePortsQuery {
    readonly q: string;
    readonly status: GamePortsStatus;
    readonly sort: GamePortsSort;
    readonly limit: number;
    readonly after: GamePortsCursor | null;
}

const cursorSchema = z.object({
    key: z.string().max(400),
    id: z.string().uuid()
});

/** The cursor as it travels in a URL. */
export function encodeGamePortsCursor(cursor: GamePortsCursor): string {
    return btoa(unescape(encodeURIComponent(JSON.stringify(cursor))))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
}

/** A cursor read back, or null for anything that is not one this page wrote. */
export function decodeGamePortsCursor(text: string): GamePortsCursor | null {
    if (text.length > 800 || !/^[A-Za-z0-9_-]+$/.test(text)) return null;
    try {
        const json = decodeURIComponent(escape(atob(text.replace(/-/g, "+").replace(/_/g, "/"))));
        const parsed = cursorSchema.safeParse(JSON.parse(json));
        return parsed.success ? parsed.data : null;
    } catch {
        return null;
    }
}

const querySchema = z.object({
    q: z.string().trim().max(GAME_PORTS_SEARCH_MAX).default(""),
    status: z.enum(GAME_PORTS_STATUSES).catch("all"),
    sort: z.enum(GAME_PORTS_SORTS).catch("name"),
    limit: z.coerce
        .number()
        .int()
        .min(1)
        .max(GAME_PORTS_PAGE_MAX)
        .catch(GAME_PORTS_PAGE_DEFAULT),
    after: z.string().max(800).optional()
});

/**
 * The query from a URL's parameters. A value out of bounds falls back to its
 * default rather than failing the page, except a search longer than the limit,
 * which is refused (null) so the route can say so.
 */
export function parseGamePortsQuery(params: URLSearchParams): GamePortsQuery | null {
    const parsed = querySchema.safeParse({
        q: params.get("q") ?? undefined,
        status: params.get("status") ?? undefined,
        sort: params.get("sort") ?? undefined,
        limit: params.get("limit") ?? undefined,
        after: params.get("after") ?? undefined
    });
    if (!parsed.success) return null;
    const after = parsed.data.after ? decodeGamePortsCursor(parsed.data.after) : null;
    if (parsed.data.after && !after) return null;
    // The newest sort keys on a timestamp, so a cursor for it must hold one.
    if (after && parsed.data.sort === "newest" && Number.isNaN(Date.parse(after.key))) return null;
    return { ...parsed.data, after };
}

/** The URL parameters for a query, leaving the defaults out. */
export function gamePortsSearch(query: Partial<Omit<GamePortsQuery, "after">> & { after?: string | null }): string {
    const params = new URLSearchParams();
    if (query.q) params.set("q", query.q);
    if (query.status && query.status !== "all") params.set("status", query.status);
    if (query.sort && query.sort !== "name") params.set("sort", query.sort);
    if (query.limit && query.limit !== GAME_PORTS_PAGE_DEFAULT) params.set("limit", String(query.limit));
    if (query.after) params.set("after", query.after);
    return params.toString();
}
