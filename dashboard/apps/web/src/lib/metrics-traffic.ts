/**
 * Turning a machine's traffic counters into how much it moved.
 *
 * Pure and kept apart from the collector so the arithmetic that once drew
 * hundreds of MB/s that never happened can be checked with a few numbers.
 */

function bigBytes(value: number | null | undefined): bigint | null {
    if (value == null || !Number.isFinite(value)) return null;
    return BigInt(Math.max(0, Math.round(value)));
}

/**
 * A probed machine's counters, keyed so `advanceTraffic` can follow each one.
 *
 * Per interface where the probe listed them: an interface that disappears then
 * takes nothing with it, and one that comes back counts from where it starts.
 * Only a reading without the list falls back to the machine's single total.
 */
export function machineTraffic(metrics: {
    netRxBytes: number | null;
    netTxBytes: number | null;
    netInterfaces?: readonly { name: string; rx: number; tx: number }[];
}): Map<string, { rx: number; tx: number }> | null {
    if (metrics.netInterfaces && metrics.netInterfaces.length > 0) {
        return new Map(
            metrics.netInterfaces.map((item) => [`if:${item.name}`, { rx: item.rx, tx: item.tx }])
        );
    }
    if (metrics.netRxBytes == null || metrics.netTxBytes == null) return null;
    return new Map([[MACHINE_TOTAL, { rx: metrics.netRxBytes, tx: metrics.netTxBytes }]]);
}

/** The key of a machine's single total, from a probe that did not list interfaces. */
const MACHINE_TOTAL = "machine";

/**
 * How much the containers on one machine have moved, as a counter that only goes
 * up.
 *
 * Summing what each container reports would not do. That sum falls the moment one
 * of them stops or is replaced, and the reader turns a counter into a rate by
 * differencing it - a fall reads as "it restarted and has moved this much since",
 * so every deploy would draw a burst of traffic that never happened. What is kept
 * instead is each container's last reading and a total that only ever has forward
 * movement added to it.
 *
 * A container seen for the first time contributes nothing: it may have been
 * running for a month before this process started, and its counter is a position,
 * not something that moved during this tick.
 *
 * Held in memory, by the one process that collects. After a restart the total
 * begins again at zero, which the reader sees as a single fall followed by
 * ordinary rates rather than as a machine that sent everything at once.
 */
const traffic = new Map<
    string,
    { rx: bigint; tx: bigint; seen: Map<string, { rx: number; tx: number }> }
>();

export function advanceTraffic(
    subjectId: string,
    readings: Map<string, { rx: number; tx: number }>
): { rx: bigint; tx: bigint } {
    const held = traffic.get(subjectId);
    let rx = held?.rx ?? 0n;
    let tx = held?.tx ?? 0n;
    for (const [id, now] of readings) {
        const before = held?.seen.get(id);
        if (!before) continue;
        rx += bigBytes(forward(id, before.rx, now.rx)) ?? 0n;
        tx += bigBytes(forward(id, before.tx, now.tx)) ?? 0n;
    }
    traffic.set(subjectId, { rx, tx, seen: readings });
    return { rx, tx };
}

/**
 * How far one counter moved between two readings.
 *
 * A container's or an interface's counter below where it was is that one
 * starting again, and what it holds now is what it moved since. A machine total
 * is not one counter but a sum, and it falls whenever something in it goes away -
 * taking what it holds as new traffic is what drew hundreds of MB/s on a server
 * at every deploy (BUG-0055), so a fall there counts nothing for that tick.
 */
function forward(id: string, before: number, now: number): number {
    if (now >= before) return now - before;
    return id === MACHINE_TOTAL ? 0 : now;
}
