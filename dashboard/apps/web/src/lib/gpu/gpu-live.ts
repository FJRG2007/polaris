/**
 * The latest GPU reading of each machine, as the metrics collector last took it.
 *
 * Kept in memory by the one process that collects, beside the history it
 * writes: the history carries the machine as one row per minute, and this
 * carries the cards one by one and which container is on which, for the panel
 * that shows them now. A machine with no card is never entered, so its panel
 * says so instead of showing an empty card list.
 */

import { HostdClient } from "@polaris/hostd-client";
import {
    gpuUsageByContainer,
    parseGpuReport,
    type ContainerGpuUsage,
    type GpuReading,
    type GpuReport
} from "./nvidia";

export interface MachineGpus {
    readonly at: number;
    readonly gpus: readonly GpuReading[];
    /** Each container's share, by the container's name. */
    readonly containers: ReadonlyMap<string, ContainerGpuUsage>;
}

/** A reading older than this is a machine that stopped answering, not one whose
 *  cards are still doing what they did. */
const STALE_MS = 10 * 60_000;

/** Held on globalThis: the collector is started from instrumentation, which is
 *  bundled apart from the routes that read this, and a module-scoped Map would
 *  be two Maps. */
const REGISTRY = Symbol.for("polaris.gpu.live");

function latestReadings(): Map<string, MachineGpus> {
    const holder = globalThis as { [REGISTRY]?: Map<string, MachineGpus> };
    if (!holder[REGISTRY]) holder[REGISTRY] = new Map();
    return holder[REGISTRY];
}

/**
 * Record what a machine's cards are doing, given its containers as the engine
 * listed them. A report with no card clears the machine, so one whose card was
 * taken out stops showing it on the next tick.
 */
export function recordMachineGpus(
    subjectId: string,
    report: GpuReport | null | undefined,
    containers: readonly { id: string; name: string }[]
): MachineGpus | null {
    const latest = latestReadings();
    if (!report || report.gpus.length === 0) {
        latest.delete(subjectId);
        return null;
    }
    const byId = gpuUsageByContainer(report, containers);
    const byName = new Map<string, ContainerGpuUsage>();
    for (const container of containers) {
        const usage = byId.get(container.id);
        if (usage) byName.set(container.name.replace(/^\//, ""), usage);
    }
    const entry: MachineGpus = { at: Date.now(), gpus: report.gpus, containers: byName };
    latest.set(subjectId, entry);
    return entry;
}

/** The machine's cards as last read, or null for a machine without one. */
export function machineGpus(subjectId: string): MachineGpus | null {
    const latest = latestReadings();
    const entry = latest.get(subjectId);
    if (!entry) return null;
    if (Date.now() - entry.at > STALE_MS) {
        latest.delete(subjectId);
        return null;
    }
    return entry;
}

/** How long the answer "this machine has no card" is trusted before the
 *  daemon is asked again: a card is not fitted to a running machine. */
const ABSENT_RECHECK_MS = 60 * 60_000;
/** How long a failed reading waits before the daemon is asked again. */
const FAILED_RECHECK_MS = 5 * 60_000;
let localAbsentUntil = 0;

/** Forget that the local machine had no card, for tests. */
export function resetLocalGpuCheck(): void {
    localAbsentUntil = 0;
}

/**
 * The machine Polaris runs on, read through the host daemon. Null where there is
 * no card, and in an edition without the daemon - which is remembered, so a
 * machine without a GPU is asked once an hour rather than every minute.
 */
export async function readLocalGpus(): Promise<GpuReport | null> {
    if (Date.now() < localAbsentUntil) return null;
    try {
        const reading = await new HostdClient().hostGpu();
        if (reading === null) return null;
        if (!reading.present) {
            localAbsentUntil = Date.now() + ABSENT_RECHECK_MS;
            return null;
        }
        return parseGpuReport(reading.output);
    } catch {
        // No daemon at all (the limited edition) or a reading that failed: asked
        // again a few minutes on, so one slow reading on a machine that has a
        // card does not hide it for the hour a machine without one waits.
        localAbsentUntil = Date.now() + FAILED_RECHECK_MS;
        return null;
    }
}
