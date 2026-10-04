/**
 * Paging for the tools that list things.
 *
 * A model reads every row it is handed, so a list tool answers a page at a time
 * and says where the next one starts. An offset rather than an opaque cursor for
 * the lists that are assembled in memory from a service that already returns the
 * whole set: the offset is what the model sends back, and there is nothing a
 * cursor would encode that the number does not.
 */

import { z } from "zod";

/** The page size a tool takes unless asked for another one. */
export const DEFAULT_PAGE = 25;

/** The most one call hands back, whatever it is asked for. */
export const MAX_PAGE = 100;

/** The fields every paged tool takes. */
export const pageFields = {
    offset: z
        .number()
        .int()
        .min(0)
        .max(100_000)
        .default(0)
        .describe("How many results to skip. Send the nextOffset of the previous call."),
    limit: z
        .number()
        .int()
        .min(1)
        .max(MAX_PAGE)
        .default(DEFAULT_PAGE)
        .describe("How many results to return.")
};

export interface Page<T> {
    readonly items: T[];
    /** Where the next page starts, or null when this was the last of them. */
    readonly nextOffset: number | null;
    readonly total: number;
}

/** One page of a list that was already read whole. */
export function pageOf<T>(rows: readonly T[], offset: number, limit: number): Page<T> {
    const items = rows.slice(offset, offset + limit);
    const end = offset + items.length;
    return { items, nextOffset: end < rows.length ? end : null, total: rows.length };
}

/** The line that tells a model there is more, or nothing when there is not. */
export function moreLine(page: Page<unknown>): string {
    return page.nextOffset === null
        ? ""
        : `\n(${page.total - page.nextOffset} more; call again with offset ${page.nextOffset})`;
}
