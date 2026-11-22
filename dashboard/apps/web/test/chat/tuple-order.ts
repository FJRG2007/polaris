/**
 * What the database does with the conversation's page cursors - `olderThan`
 * and `newerThan` in `lib/chat/search` - for the fakes that answer a message
 * query in memory. Any other clause passes.
 */

type Bound = { lt?: Date; lte?: Date; gt?: Date; gte?: Date };
type Branch = { createdAt: Bound | Date; id?: { lt?: string; gt?: string } };

function within(at: Date, bound: Bound | Date): boolean {
    if (bound instanceof Date) return at.getTime() === bound.getTime();
    if (bound.lt && !(at < bound.lt)) return false;
    if (bound.lte && !(at <= bound.lte)) return false;
    if (bound.gt && !(at > bound.gt)) return false;
    if (bound.gte && !(at >= bound.gte)) return false;
    return true;
}

export function inOrder(clause: unknown, row: { createdAt: Date; id: string }): boolean {
    const tuple = clause as { createdAt?: Bound; OR?: Branch[] } | null;
    if (!tuple?.OR || !tuple.createdAt) return true;
    if (!within(row.createdAt, tuple.createdAt)) return false;
    return tuple.OR.some(
        (branch) =>
            within(row.createdAt, branch.createdAt) &&
            (!branch.id || (branch.id.lt !== undefined ? row.id < branch.id.lt : row.id > (branch.id.gt ?? "")))
    );
}

/** The leading sort of an `orderBy` given as one object or as a list. */
export function leading(orderBy: unknown): "asc" | "desc" | undefined {
    const first = (Array.isArray(orderBy) ? orderBy[0] : orderBy) as { createdAt?: "asc" | "desc" } | undefined;
    return first?.createdAt;
}
