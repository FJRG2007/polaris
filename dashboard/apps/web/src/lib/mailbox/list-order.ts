/**
 * What order a list of conversations comes back in, and where the next page
 * starts.
 *
 * Pure on purpose - these build plain objects and read plain rows, and nothing
 * here touches a database - because the paging is the part that goes wrong
 * silently. A cursor that is a shade too generous shows somebody the same page
 * twice; one that is a shade too strict skips conversations and nobody ever
 * finds out. Both are testable here without a mailbox.
 *
 * Two shapes of cursor, for the two kinds of order:
 *
 * - **by time**, the moment of the page's edge, which is what a mail list has
 *   always been paged on;
 * - **by size**, the size of the page's edge together with the id of that row,
 *   because sizes tie constantly - a folder of short replies is a hundred
 *   conversations of the same few kilobytes, and a cursor of size alone would
 *   hand back the same page for ever.
 *
 * The edge is the smallest row of the page under the order being read, not the
 * last one drawn: pinned conversations sort to the top whatever the order says,
 * so the last row and the smallest row are different rows the moment anything is
 * pinned. Anchoring on the smallest is what stops the page after it skipping
 * everything between the two.
 */

import type { MailSort } from "@polaris/core";

/** One `orderBy` entry, as Prisma takes them. */
export type MailOrderBy = Readonly<Record<string, "asc" | "desc">>;

/** What the cursor is measured against: the two columns the orders read, and the
 *  id that breaks a tie between two of the same size. */
export interface MailOrderRow {
    readonly id: string;
    readonly lastMessageAt: string;
    readonly size: number;
}

/**
 * The order itself.
 *
 * Pinned first in every one of them. A conversation somebody pinned is pinned in
 * the list they are looking at, whichever way round it is - an order that moved
 * pins to the bottom when it was reversed would be reading "keep this at the top"
 * as a date.
 *
 * The size orders carry the id as their last word so that two conversations of
 * the same size come back in the same order every time. Without it the database
 * is free to return them in any order it likes, which is exactly the freedom the
 * cursor below cannot survive.
 */
export function mailOrderBy(sort: MailSort): MailOrderBy[] {
    if (sort === "oldest") return [{ pinned: "desc" }, { lastMessageAt: "asc" }];
    if (sort === "largest") return [{ pinned: "desc" }, { size: "desc" }, { id: "desc" }];
    if (sort === "smallest") return [{ pinned: "desc" }, { size: "asc" }, { id: "asc" }];
    return [{ pinned: "desc" }, { lastMessageAt: "desc" }];
}

/** Whether an order is read by size rather than by time. */
function bySize(sort: MailSort): boolean {
    return sort === "largest" || sort === "smallest";
}

/**
 * Where the next page begins, from the page just drawn.
 *
 * Empty when there is no next page, which is what a page shorter than it asked
 * for means, and what the list uses to stop asking.
 */
export function mailCursorOf(sort: MailSort, rows: readonly MailOrderRow[], limit: number): string {
    if (rows.length === 0 || rows.length < limit) return "";
    const edge = rows.reduce((held, row) => (further(sort, row, held) ? row : held));
    return bySize(sort) ? `${edge.size}:${edge.id}` : edge.lastMessageAt;
}

/** Whether `row` is further along the order than `held` - the row a page would
 *  end on if nothing were pinned. */
function further(sort: MailSort, row: MailOrderRow, held: MailOrderRow): boolean {
    if (sort === "newest") return row.lastMessageAt < held.lastMessageAt;
    if (sort === "oldest") return row.lastMessageAt > held.lastMessageAt;
    if (sort === "largest") return row.size < held.size || (row.size === held.size && row.id < held.id);
    return row.size > held.size || (row.size === held.size && row.id > held.id);
}

/**
 * The narrowing that leaves out everything already shown.
 *
 * An empty object when there is no cursor, so the first page of every list is
 * the same query with nothing added to it.
 *
 * A cursor that cannot be read - an address somebody edited, a cursor from a
 * different order still on the URL when the order changed - is treated as no
 * cursor at all. The list starting from the top is a correct answer to a
 * nonsense page; an empty list is not.
 */
export function mailCursorWhere(sort: MailSort, cursor: string): Record<string, unknown> {
    if (!cursor.trim()) return {};

    if (!bySize(sort)) {
        const at = new Date(cursor);
        if (Number.isNaN(at.getTime())) return {};
        return { lastMessageAt: sort === "oldest" ? { gt: at } : { lt: at } };
    }

    const split = cursor.indexOf(":");
    if (split <= 0) return {};
    const size = Number(cursor.slice(0, split));
    const id = cursor.slice(split + 1);
    if (!Number.isFinite(size) || !id) return {};
    // Read as one two-part number: past this size, or the same size and past this
    // row. Written out because a database has no way to compare a pair.
    return sort === "largest"
        ? { OR: [{ size: { lt: size } }, { size, id: { lt: id } }] }
        : { OR: [{ size: { gt: size } }, { size, id: { gt: id } }] };
}
