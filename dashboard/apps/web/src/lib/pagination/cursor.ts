/**
 * Keyset pagination: a page of a list that can grow without limit, and where the
 * next one starts.
 *
 * Keyset rather than an offset because an offset is read by counting past every
 * row before it - page two hundred costs two hundred pages - and because a row
 * added or removed while somebody scrolls shifts every offset after it, so a
 * person is shown twice or skipped. A keyset names the last row seen, by the
 * column the list is ordered on and its id to break ties, and the next page is
 * whatever comes after it: one index range scan, however deep.
 *
 * The cursor is opaque to the browser - base64url of that pair - and validated
 * on the way back in, so a hand-made one is no page rather than an error.
 */

import { z } from "zod";

/** The largest page anybody may ask for, whatever they ask for. */
export const MAX_PAGE = 200;

/** A page and where the next one starts, or null at the end. */
export interface Page<T> {
    readonly items: T[];
    readonly next: string | null;
}

/** Where a page starts: the last row of the one before, by its order and id. */
export interface Keyset {
    readonly at: Date;
    readonly id: string;
}

const keysetSchema = z.tuple([z.string().datetime(), z.string().uuid()]);

export function encodeCursor(keyset: Keyset): string {
    return Buffer.from(JSON.stringify([keyset.at.toISOString(), keyset.id])).toString("base64url");
}

/** A cursor read back, or null for none and for anything that is not one. */
export function decodeCursor(raw: string | null | undefined): Keyset | null {
    if (!raw || raw.length > 200) return null;
    try {
        const parsed = keysetSchema.safeParse(
            JSON.parse(Buffer.from(raw, "base64url").toString("utf8"))
        );
        return parsed.success ? { at: new Date(parsed.data[0]), id: parsed.data[1] } : null;
    } catch {
        return null;
    }
}

/** The rows after a keyset, for a list ordered ascending on `field` then `id`. */
export function after(field: string, keyset: Keyset | null): Record<string, unknown> {
    if (!keyset) return {};
    return {
        OR: [{ [field]: { gt: keyset.at } }, { [field]: keyset.at, id: { gt: keyset.id } }]
    };
}

/** A requested page size, held between one and the most anybody gets. */
export function pageSize(asked: number | undefined, fallback: number): number {
    if (asked === undefined || !Number.isFinite(asked)) return fallback;
    return Math.min(MAX_PAGE, Math.max(1, Math.floor(asked)));
}

/**
 * A page out of rows read one past it: the extra row is how the end is known
 * without counting, and is not returned.
 */
export function pageOf<T>(rows: T[], size: number, keyOf: (row: T) => Keyset): Page<T> {
    const items = rows.slice(0, size);
    const last = items[items.length - 1];
    return { items, next: rows.length > size && last ? encodeCursor(keyOf(last)) : null };
}
