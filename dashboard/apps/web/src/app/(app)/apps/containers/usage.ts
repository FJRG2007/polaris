/**
 * Keeping a usage reading on screen once it has been shown.
 *
 * The listing is answered from the last sample the server holds, which is not
 * always one it has: a machine nobody has looked at since the process started, or
 * a Docker connection the metrics collector does not walk, answers with the
 * containers and no figures. That is fine on a first visit - the numbers arrive a
 * poll later - but the table may already be showing figures, either from the
 * snapshot this tab kept or from the poll before, and replacing those with blanks
 * is a screen going backwards.
 *
 * So a row that comes back without a reading keeps the one it had, and keeps the
 * instant that reading was taken with it, which is what lets the header go on
 * saying how old it is instead of quietly presenting it as current. Only a running
 * container carries anything forward: a stopped one has no usage, and a number
 * beside "exited" would read as though it were still working.
 */

import type { ContainerRow, HostSnapshot } from "./types";

/** The fields that make up one reading, carried together so a value and its age
 *  can never come from different samples. */
type Usage = Pick<ContainerRow, "cpuPercent" | "memUsage" | "memPercent" | "statsAt">;

function hasReading(row: Usage): boolean {
    return row.statsAt !== null && (row.cpuPercent !== null || row.memUsage !== null);
}

/**
 * `next`, with any running container's missing reading filled in from `previous`.
 * Returns `next` untouched when there is nothing to carry, so an unchanged answer
 * stays the same object and the table does not re-render.
 */
export function carryForwardUsage(previous: HostSnapshot | null, next: HostSnapshot): HostSnapshot {
    if (!previous) return next;
    const held = new Map<string, Usage>();
    for (const row of previous.containers) {
        if (hasReading(row)) held.set(row.id, row);
    }
    if (held.size === 0) return next;

    let filled = false;
    const containers = next.containers.map((row) => {
        if (row.state !== "running" || hasReading(row)) return row;
        const last = held.get(row.id);
        if (!last) return row;
        filled = true;
        return { ...row, ...last };
    });
    if (!filled) return next;

    // The header's age comes from the newest reading on the host, so it has to be
    // recomputed over what is actually on screen - otherwise a table full of
    // carried-forward figures reports no reading at all.
    const newest = containers.reduce<number | null>(
        (latest, row) => (row.statsAt !== null && (latest === null || row.statsAt > latest) ? row.statsAt : latest),
        next.statsAt
    );
    return { ...next, containers, statsAt: newest };
}
