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
 * Both of them carry one thing more: whether the edge was pinned. Pinned
 * conversations sort to the top whatever the order says, so a list is really two
 * lists end to end - the pinned ones in that order, then the rest in the same
 * order - and a cursor naming only a size or a moment cannot say which of the
 * two it stopped in. That is not a detail. A single pinned conversation of a
 * kilobyte, in a folder read largest first, is the smallest row on the first
 * page: anchoring the next page on it asks for everything below a kilobyte and
 * silently drops every conversation between there and the page just drawn.
 *
 * So the edge is the furthest row of the half the page ended in, and the
 * narrowing below says which half to carry on from.
 */

import type { MailSort } from "@polaris/core";

/** One `orderBy` entry, as Prisma takes them. */
export type MailOrderBy = Readonly<Record<string, "asc" | "desc">>;

/** What the cursor is measured against: the two columns the orders read, the id
 *  that breaks a tie between two of the same size, and the flag that decides
 *  which half of the list a row is in. */
export interface MailOrderRow {
    readonly id: string;
    readonly lastMessageAt: string;
    readonly size: number;
    readonly pinned: boolean;
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
 *
 * The edge is read out of the unpinned half wherever the page reached it, since
 * that is the half the next page continues in. A page that is all pins - more of
 * them than fit on one page - hands over a pinned edge instead, and the
 * narrowing below carries on through the rest of them before it reaches
 * anything else.
 */
export function mailCursorOf(sort: MailSort, rows: readonly MailOrderRow[], limit: number): string {
    if (rows.length === 0 || rows.length < limit) return "";
    const open = rows.filter((row) => !row.pinned);
    const half = open.length > 0 ? open : rows;
    const edge = half.reduce((held, row) => (further(sort, row, held) ? row : held));
    const at = bySize(sort) ? `${edge.size}:${edge.id}` : edge.lastMessageAt;
    return `${edge.pinned ? "1" : "0"}|${at}`;
}

/** Whether `row` is further along the order than `held` - the row a page would
 *  end on, within the half of the list it is in. */
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
    const trimmed = cursor.trim();
    if (!trimmed) return {};
    if (trimmed[1] !== "|" || (trimmed[0] !== "0" && trimmed[0] !== "1")) return {};

    const past = pastEdge(sort, trimmed.slice(2));
    if (!past) return {};
    // An unpinned edge is the simple half: the pins are all above it and were all
    // drawn. A pinned one still has the rest of the pins to go, and then the
    // whole of the unpinned list after them.
    return trimmed[0] === "1"
        ? { OR: [{ pinned: true, ...past }, { pinned: false }] }
        : { pinned: false, ...past };
}

/** Everything past one edge, in whatever shape the order reads. Null for an edge
 *  this order cannot make sense of. */
function pastEdge(sort: MailSort, edge: string): Record<string, unknown> | null {
    if (!bySize(sort)) {
        const at = new Date(edge);
        if (Number.isNaN(at.getTime())) return null;
        return { lastMessageAt: sort === "oldest" ? { gt: at } : { lt: at } };
    }

    const split = edge.indexOf(":");
    if (split <= 0) return null;
    const size = Number(edge.slice(0, split));
    const id = edge.slice(split + 1);
    if (!Number.isFinite(size) || !id) return null;
    // Read as one two-part number: past this size, or the same size and past this
    // row. Written out because a database has no way to compare a pair.
    return sort === "largest"
        ? { OR: [{ size: { lt: size } }, { size, id: { lt: id } }] }
        : { OR: [{ size: { gt: size } }, { size, id: { gt: id } }] };
}
