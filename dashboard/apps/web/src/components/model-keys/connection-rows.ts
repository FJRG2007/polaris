/**
 * The rows of the one connections table and how its toolbar narrows and sorts
 * them. Pure, so the table's search, filters and sort are asserted without a
 * screen.
 *
 * Four kinds share the table: a provider key, an agent account (a stored
 * credential an agent signs in with), an agent signed in on the sessions'
 * machine (nothing stored, the login lives in that home), and a key the
 * deployment holds (read-only, the fallback, always last).
 */

import { foldSearch, type TableSortDirection } from "@polaris/ui";

export type ConnectionKind = "key" | "account" | "agent" | "deployment";
export type ConnectionStatus = "working" | "off" | "problem" | "checking";
export type ConnectionSort = "priority" | "provider" | "name" | "status" | "lastUsed";

export interface ConnectionEntry {
    id: string;
    kind: ConnectionKind;
    /** The provider's slug, which the provider filter matches. */
    provider: string;
    providerName: string;
    name: string;
    status: ConnectionStatus;
    lastUsedAt: string | null;
    /** Position in the stored order; virtual rows come after every stored one. */
    position: number;
}

export interface ConnectionFilters {
    query: string;
    provider: string;
    kind: ConnectionKind | "all";
    status: ConnectionStatus | "all";
}

export const NO_FILTERS: ConnectionFilters = { query: "", provider: "all", kind: "all", status: "all" };

/** Whether anything narrows the table, which is when its order cannot be
 *  changed: a move between two rows that are not next to each other is not
 *  the move somebody sees. Pure. */
export function isNarrowed(filters: ConnectionFilters): boolean {
    return filters.query.trim() !== "" || filters.provider !== "all" || filters.kind !== "all" || filters.status !== "all";
}

const STATUS_RANK: Record<ConnectionStatus, number> = { problem: 0, checking: 1, working: 2, off: 3 };
/** The deployment's keys are the fallback, so they stay under the account's own
 *  whatever the sort is. */
const KIND_TIER: Record<ConnectionKind, number> = { key: 0, account: 0, agent: 0, deployment: 1 };

/** The rows the toolbar leaves, in the order it asks for. Pure. */
export function arrangeConnections(
    entries: readonly ConnectionEntry[],
    filters: ConnectionFilters,
    sort: { order: ConnectionSort; direction: TableSortDirection }
): ConnectionEntry[] {
    const words = foldSearch(filters.query).split(/\s+/).filter(Boolean);
    const kept = entries.filter((entry) => {
        if (filters.provider !== "all" && entry.provider !== filters.provider) return false;
        if (filters.kind !== "all" && entry.kind !== filters.kind) return false;
        if (filters.status !== "all" && entry.status !== filters.status) return false;
        if (words.length === 0) return true;
        const haystack = foldSearch(`${entry.name} ${entry.providerName} ${entry.provider}`);
        return words.every((word) => haystack.includes(word));
    });
    const sign = sort.direction === "asc" ? 1 : -1;
    const compare = (a: ConnectionEntry, b: ConnectionEntry): number => {
        switch (sort.order) {
            case "provider":
                return a.providerName.localeCompare(b.providerName) || a.name.localeCompare(b.name);
            case "name":
                return a.name.localeCompare(b.name);
            case "status":
                return STATUS_RANK[a.status] - STATUS_RANK[b.status];
            case "lastUsed":
                return (a.lastUsedAt ?? "").localeCompare(b.lastUsedAt ?? "");
            default:
                return a.position - b.position;
        }
    };
    return [...kept].sort(
        (a, b) => KIND_TIER[a.kind] - KIND_TIER[b.kind] || sign * compare(a, b) || a.position - b.position
    );
}
