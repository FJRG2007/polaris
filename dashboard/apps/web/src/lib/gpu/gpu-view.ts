/**
 * A machine's cards as the server page draws them: each card, and the
 * containers holding memory on them, heaviest first.
 *
 * Plain data so it can cross to the browser and be asserted in a test without
 * the collector behind it.
 */

import type { GpuReading } from "./nvidia";
import type { MachineGpus } from "./gpu-live";

/** Most containers listed under the cards; the rest are the long tail of a
 *  shared machine and are counted, not named. */
export const MAX_GPU_CONTAINERS = 20;

export interface GpuContainerRow {
    readonly name: string;
    readonly memoryUsedBytes: number;
    /** The cards it is on, as the machine numbers them. */
    readonly gpuIndexes: readonly number[];
}

export interface MachineGpuView {
    /** When the cards were read, epoch ms; null where there is no card. */
    readonly at: number | null;
    readonly gpus: readonly GpuReading[];
    readonly containers: readonly GpuContainerRow[];
    /** Containers on a card beyond the ones listed. */
    readonly moreContainers: number;
    /** The containers were left out because the reader may not see them. */
    readonly containersHidden: boolean;
}

export const NO_GPUS: MachineGpuView = { at: null, gpus: [], containers: [], moreContainers: 0, containersHidden: false };

/** `showContainers` false keeps the cards and leaves out what runs on them: the
 *  machine Polaris runs on carries every user's containers. */
export function machineGpuView(entry: MachineGpus | null, showContainers = true): MachineGpuView {
    if (!entry || entry.gpus.length === 0) return NO_GPUS;
    if (!showContainers) return { at: entry.at, gpus: entry.gpus, containers: [], moreContainers: 0, containersHidden: true };
    const indexOf = new Map(entry.gpus.map((gpu) => [gpu.uuid, gpu.index]));
    const rows = [...entry.containers]
        .map(([name, usage]) => ({
            name,
            memoryUsedBytes: usage.memoryUsedBytes,
            gpuIndexes: usage.gpuUuids
                .map((uuid) => indexOf.get(uuid))
                .filter((index): index is number => index !== undefined)
        }))
        .sort((a, b) => b.memoryUsedBytes - a.memoryUsedBytes || a.name.localeCompare(b.name));
    return {
        at: entry.at,
        gpus: entry.gpus,
        containers: rows.slice(0, MAX_GPU_CONTAINERS),
        moreContainers: Math.max(0, rows.length - MAX_GPU_CONTAINERS),
        containersHidden: false
    };
}
