/**
 * Which containers of a host the table shows, and in what order.
 *
 * Applied by /api/containers before it answers, so a host running hundreds of
 * containers sends the browser the page somebody is looking at rather than the
 * whole listing. Pure and client-safe: the view reuses the same words for its
 * controls and the same parameters for the request it makes.
 */

import {
    DEFAULT_DIRECTION,
    sortByConsumption,
    type ConsumptionOrder,
    type SortDirection
} from "@/lib/watch/card-order";

/** Whose containers: Polaris's own stack, everything else, or both. */
export type OwnerFilter = "all" | "polaris" | "other";

/** A state as somebody filters by it. The engine has seven words for it; three
 *  of them are what a person means by "running", "stopped" and "paused". */
export type StateFilter = "all" | "running" | "stopped" | "paused";

export const OWNER_FILTERS: readonly OwnerFilter[] = ["all", "polaris", "other"];
export const STATE_FILTERS: readonly StateFilter[] = ["all", "running", "stopped", "paused"];
export const LIST_ORDERS: readonly ConsumptionOrder[] = ["name", "state", "cpu", "memory"];

/** Rows per page, and how many more each "Show more" asks for. */
export const PAGE_SIZE = 50;
/** The most rows one answer carries, whatever a caller asks for. */
export const MAX_LIMIT = 1000;

export interface ContainerListQuery {
    /** Matched against the name and the image, ignoring case. */
    q: string;
    owner: OwnerFilter;
    state: StateFilter;
    /** Null keeps the engine's own order, which is what a caller that predates
     *  sorting here was sent. */
    order: ConsumptionOrder | null;
    direction: SortDirection;
    /** How many rows to send. Null sends every match, which is what a caller that
     *  predates paging asked for. */
    limit: number | null;
}

export const DEFAULT_LIST_QUERY: ContainerListQuery = {
    q: "",
    owner: "all",
    state: "all",
    order: "name",
    direction: DEFAULT_DIRECTION.name,
    limit: PAGE_SIZE
};

/** What filtering needs of a row. */
export interface ListedContainer {
    readonly name: string;
    readonly image: string;
    readonly state: string;
    readonly polaris: boolean;
    readonly cpuPercent: number | null;
    readonly memUsage: number | null;
}

/** Which of the three filter states an engine state falls under. Restarting is
 *  on its way back up, so it is counted with the running ones. */
export function stateGroup(state: string): Exclude<StateFilter, "all"> {
    if (state === "running" || state === "restarting") return "running";
    if (state === "paused") return "paused";
    return "stopped";
}

export function matchesQuery(
    row: ListedContainer,
    query: Pick<ContainerListQuery, "q" | "owner" | "state">
): boolean {
    if (query.owner === "polaris" && !row.polaris) return false;
    if (query.owner === "other" && row.polaris) return false;
    if (query.state !== "all" && stateGroup(row.state) !== query.state) return false;
    const needle = query.q.trim().toLowerCase();
    if (!needle) return true;
    return row.name.toLowerCase().includes(needle) || row.image.toLowerCase().includes(needle);
}

/**
 * The rows a query selects, ordered and cut to its limit, with how many matched
 * before the cut so the screen can say there are more.
 */
export function queryContainers<T extends ListedContainer>(
    rows: readonly T[],
    query: ContainerListQuery
): { rows: T[]; matched: number } {
    const matching = rows.filter((row) => matchesQuery(row, query));
    // The sort calls memory what every other screen does; carried beside the row
    // rather than renamed, so what comes back is still the caller's own rows.
    const ordered =
        query.order === null
            ? matching
            : sortByConsumption(
                  matching.map((row) => ({
                      row,
                      name: row.name,
                      state: row.state,
                      cpuPercent: row.cpuPercent,
                      memUsedBytes: row.memUsage
                  })),
                  query.order,
                  query.direction
              ).map((entry) => entry.row);
    const limit = query.limit === null ? ordered.length : Math.min(query.limit, MAX_LIMIT);
    return { rows: ordered.slice(0, limit), matched: matching.length };
}

/** The query string the view sends for a query, leaving out what is default so
 *  the address stays short and a cache key stays stable. */
export function listSearchParams(connectionId: string, query: ContainerListQuery): URLSearchParams {
    const params = new URLSearchParams({ c: connectionId });
    const q = query.q.trim();
    if (q) params.set("q", q);
    if (query.owner !== "all") params.set("owner", query.owner);
    if (query.state !== "all") params.set("state", query.state);
    if (query.order !== null) {
        params.set("sort", query.order);
        params.set("dir", query.direction);
    }
    if (query.limit !== null) params.set("limit", String(query.limit));
    return params;
}
