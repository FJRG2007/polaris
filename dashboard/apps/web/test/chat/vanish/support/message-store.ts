/**
 * A tiny message table that answers the where clauses the chat readers build,
 * the way the database would - floors, expiry, hidden-for-me - so a test can
 * run the real visibility module against it.
 */

export interface StoredMessage {
    id: string;
    channelId: string;
    createdAt: Date;
    expiresAt: Date | null;
    parentId: string | null;
    hiddenFor: string[];
}

type Where = Record<string, unknown>;

function compares(value: Date | null, filter: Record<string, Date>): boolean {
    if (value === null) return false;
    if (filter.gte && value < filter.gte) return false;
    if (filter.gt && !(value > filter.gt)) return false;
    if (filter.lt && !(value < filter.lt)) return false;
    if (filter.lte && value > filter.lte) return false;
    return true;
}

function matchesId(value: string | null, filter: unknown): boolean {
    if (filter === null || typeof filter === "string") return value === filter;
    const set = filter as { in?: string[]; notIn?: string[] };
    if (set.in && !set.in.includes(value ?? "")) return false;
    if (set.notIn && set.notIn.includes(value ?? "")) return false;
    return true;
}

/** Whether a row passes a where clause. Keys the readers do not use pass. */
export function matches(row: StoredMessage, where: Where | undefined): boolean {
    if (!where) return true;
    return Object.entries(where).every(([key, filter]) => {
        switch (key) {
            case "AND":
                return (filter as Where[]).every((inner) => matches(row, inner));
            case "OR":
                return (filter as Where[]).some((inner) => matches(row, inner));
            case "NOT":
                return !matches(row, filter as Where);
            case "id":
            case "channelId":
                return matchesId(row[key], filter);
            case "parentId":
                return matchesId(row.parentId, filter);
            case "createdAt":
                return compares(row.createdAt, filter as Record<string, Date>);
            case "expiresAt":
                return filter === null
                    ? row.expiresAt === null
                    : compares(row.expiresAt, filter as Record<string, Date>);
            case "hiddenFor": {
                const none = (filter as { none?: { userId: string } }).none;
                return none ? !row.hiddenFor.includes(none.userId) : true;
            }
            default:
                return true;
        }
    });
}
