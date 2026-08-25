/**
 * The order a list of monitored things is read in.
 *
 * Sorted by name a list answers "where is the one I am thinking of". Sorted by
 * consumption it answers the question the screen exists for - which of these is
 * working hardest - and that is the one nobody could ask before, on a box where
 * the busiest container was somewhere in the middle of thirty.
 *
 * Pure, and shared by the cards in Watch and the table in Containers, so the two
 * screens cannot disagree about what "busiest" means.
 */

export type ConsumptionOrder = "cpu" | "memory" | "name" | "state";

export type SortDirection = "asc" | "desc";

/** What sorting needs of a row. Structural, so a Watch card and a container row
 *  both satisfy it without either module importing the other. */
export interface ConsumptionRow {
    readonly name: string;
    readonly cpuPercent: number | null;
    readonly memUsedBytes: number | null;
    /** Whatever the screen calls its state; only ever compared with itself. */
    readonly state?: string;
}

/** Which way round each order reads first, so one click gives the useful answer:
 *  the busiest first, but names from A. */
export const DEFAULT_DIRECTION: Record<ConsumptionOrder, SortDirection> = {
    cpu: "desc",
    memory: "desc",
    name: "asc",
    state: "asc"
};

export const ORDER_LABELS: Record<ConsumptionOrder, string> = {
    cpu: "CPU",
    memory: "Memory",
    name: "Name",
    state: "State"
};

/** Whether this row has nothing to compare for the given order. */
function unmeasured(row: ConsumptionRow, order: ConsumptionOrder): boolean {
    if (order === "cpu") return row.cpuPercent == null;
    if (order === "memory") return row.memUsedBytes == null;
    return false;
}

function primary(left: ConsumptionRow, right: ConsumptionRow, order: ConsumptionOrder): number {
    if (order === "name") return left.name.localeCompare(right.name);
    if (order === "state") return (left.state ?? "").localeCompare(right.state ?? "");
    if (order === "cpu") return (left.cpuPercent ?? 0) - (right.cpuPercent ?? 0);
    return (left.memUsedBytes ?? 0) - (right.memUsedBytes ?? 0);
}

/**
 * A copy of `rows` in the given order.
 *
 * Never sorted in place: what is passed here is usually the last answer from the
 * server, held to be shown again on the next render.
 *
 * A row with no reading sorts last whichever way round the rest goes - a stopped
 * container has not won the contest for using the least CPU, it is not in it -
 * and rows that tie fall back to their names, so flipping the direction never
 * shuffles the ones that are level with each other.
 */
export function sortByConsumption<T extends ConsumptionRow>(
    rows: readonly T[],
    order: ConsumptionOrder,
    direction: SortDirection = DEFAULT_DIRECTION[order]
): T[] {
    const flip = direction === "desc" ? -1 : 1;
    return [...rows].sort((left, right) => {
        const missing = Number(unmeasured(left, order)) - Number(unmeasured(right, order));
        if (missing !== 0) return missing;
        const ranked = primary(left, right, order) * flip;
        return ranked !== 0 ? ranked : left.name.localeCompare(right.name);
    });
}
