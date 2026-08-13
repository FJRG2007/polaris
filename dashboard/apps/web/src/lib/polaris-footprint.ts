/**
 * What Polaris itself costs the machine it runs on.
 *
 * Every other reading in the dashboard is about something Polaris manages - a
 * deployed app, a game server, a disk. This is the one about Polaris, and it was
 * the only thing on the box nobody could see a figure for: its own containers sit
 * in the Containers table mixed in with everything deployed, so the question
 * "what is the control plane actually using" could only be answered by reading a
 * list and adding it up by eye.
 *
 * Polaris is its compose project, not its container names. Names are the
 * operator's to choose and change with every self-update (`polaris-web-154`
 * becomes `polaris-web-181`); the project label is written by compose and is what
 * actually says a container belongs to this stack. Its own tunnels are their own
 * projects, and they are here too - a tunnel exists to publish Polaris, so what it
 * costs is part of what Polaris costs.
 *
 * Reading it is deliberately not free: memory and CPU are one sample per
 * container, and disk means asking each container to measure its own volumes. So
 * it is read on request and held briefly, rather than collected on a timer for a
 * panel almost nobody has open.
 */

import type { DockerDriver } from "@polaris/docker";
import { HostdPorts } from "@/lib/deploy/ports-hostd";
import { localDockerDriver } from "@/lib/docker-service";
import { describePart, isPolarisPart } from "@/lib/polaris-parts";
import type { FootprintPart, FootprintVolume, PolarisFootprint } from "@/app/(app)/apps/containers/types";

/** How long a reading is worth serving again. Long enough that a page open in two
 *  tabs, or reloaded while somebody reads it, costs one measurement; short enough
 *  that it is still describing now. */
const CACHE_MS = 60_000;

let cached: { at: number; footprint: PolarisFootprint } | null = null;

/**
 * Measure Polaris.
 *
 * @param force Skip the held reading. For the button that asks for a fresh one.
 */
export async function readPolarisFootprint(force = false): Promise<PolarisFootprint> {
    if (!force && cached && Date.now() - cached.at < CACHE_MS) return cached.footprint;
    const driver = localDockerDriver();
    try {
        const footprint = await measure(driver);
        cached = { at: Date.now(), footprint };
        return footprint;
    } finally {
        await driver.dispose().catch(() => undefined);
    }
}

async function measure(driver: DockerDriver): Promise<PolarisFootprint> {
    const own = (await driver.listContainers(true)).filter(isPolarisPart);
    const running = own.filter((container) => container.state === "running");
    const [info, stats] = await Promise.all([
        driver.info().catch(() => null),
        driver.statsMany(running.map((container) => container.id))
    ]);

    // One inspect per part, for what it has written and what its image weighs.
    // `size` is the whole reason to ask: the fields are absent without it.
    const details = new Map(
        await Promise.all(
            own.map(
                async (container) =>
                    [container.id, await driver.inspect(container.id, { size: true }).catch(() => null)] as const
            )
        )
    );

    // Volumes are measured from inside the container that mounts them, which is
    // the one place a named volume has a path at all. Once each: several parts
    // mount the same volume, and counting it twice would report a stack twice the
    // size of the one on disk.
    const ports = new HostdPorts();
    /** Every named volume the stack mounts, measured or not - which is what says
     *  whether the disk figures are a total or a floor. */
    const seen = new Set<string>();
    /** Only the readings that came back. A failed attempt is not cached as a
     *  measurement of null, or the first part to mount a shared volume while
     *  stopped would settle it for every running part that mounts it too. */
    const measured = new Map<string, number>();
    const parts: FootprintPart[] = [];
    try {
        for (const container of own) {
            const detail = details.get(container.id) ?? null;
            const sample = stats.get(container.id) ?? null;
            const volumes: FootprintVolume[] = [];
            for (const mount of detail?.mounts ?? []) {
                if (!mount.name) continue;
                seen.add(mount.name);
                // A stopped part cannot be asked, and a read-only mount is
                // somebody else's volume seen from here - both are measured
                // wherever they are writable and running, or not at all.
                if (!measured.has(mount.name) && container.state === "running" && mount.rw) {
                    const used = await ports.diskUsage(container.name, mount.destination);
                    if (used !== null) measured.set(mount.name, used);
                }
                volumes.push({ name: mount.name, path: mount.destination, usedBytes: null });
            }
            parts.push({
                id: container.id,
                name: container.name,
                ...describePart(container),
                image: container.image,
                state: container.state,
                cpuPercent: sample ? Math.round(sample.cpuPercent * 100) / 100 : null,
                memUsedBytes: sample?.memUsage ?? null,
                writableBytes: detail?.sizeRw ?? null,
                imageBytes:
                    detail && detail.sizeRootFs !== null ? Math.max(0, detail.sizeRootFs - (detail.sizeRw ?? 0)) : null,
                volumes
            });
        }
    } finally {
        await ports.dispose().catch(() => undefined);
    }

    // Filled in once every part has been walked, so a volume a stopped part
    // mounts still carries the figure the running part that shares it measured,
    // whichever of the two the engine listed first.
    const measuredParts = parts.map((part) => ({
        ...part,
        volumes: part.volumes.map((volume) => ({ ...volume, usedBytes: measured.get(volume.name) ?? null }))
    }));

    // An image shared by two parts is one image on disk. Keyed by what the part
    // reports as its image, which is the same string for both.
    const images = new Map<string, number>();
    for (const part of measuredParts) {
        if (part.imageBytes !== null) images.set(part.image, part.imageBytes);
    }

    return {
        parts: measuredParts,
        memUsedBytes: sum(measuredParts.map((part) => part.memUsedBytes)),
        memTotalBytes: info?.memTotal ?? null,
        cpuPercent: Math.round(sum(measuredParts.map((part) => part.cpuPercent)) * 100) / 100,
        imageBytes: [...images.values()].reduce((total, bytes) => total + bytes, 0),
        writableBytes: sum(measuredParts.map((part) => part.writableBytes)),
        volumeBytes: [...measured.values()].reduce((total, bytes) => total + bytes, 0),
        diskComplete: seen.size === measured.size,
        at: new Date().toISOString()
    };
}

function sum(values: readonly (number | null)[]): number {
    return values.reduce<number>((total, value) => total + (value ?? 0), 0);
}
