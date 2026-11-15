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

import type { ContainerStats, ContainerSummary, DockerDriver } from "@polaris/docker";
import { cachedSamples, rememberSample } from "@/lib/container-stats-cache";
import { HostdPorts } from "@/lib/deploy/ports-hostd";
import { LOCAL_DOCKER_CONNECTION_ID, localDockerDriver } from "@/lib/docker-service";
import { describePart, isPolarisPart } from "@/lib/polaris-parts";
import type {
    FootprintPart,
    FootprintRest,
    FootprintVolume,
    PolarisFootprint
} from "@/app/(app)/apps/containers/types";

/** How long a reading is worth serving again. Long enough that a page open in two
 *  tabs, or reloaded while somebody reads it, costs one measurement; short enough
 *  that it is still describing now. */
const CACHE_MS = 60_000;

let cached: { at: number; footprint: PolarisFootprint } | null = null;

/** The measurement under way, if there is one. The cache only spares the second
 *  reader who arrives after the first has finished; this one spares the second
 *  reader who arrives while it is still running - two tabs pressing Measure
 *  again, a reload mid-measure - which is the expensive case, since a forced
 *  read walks every part with `size` and asks each running container to measure
 *  its own volumes. */
let running: Promise<PolarisFootprint> | null = null;

/**
 * Measure Polaris.
 *
 * @param force Skip the held reading. For the button that asks for a fresh one.
 */
export async function readPolarisFootprint(force = false): Promise<PolarisFootprint> {
    if (!force && cached && Date.now() - cached.at < CACHE_MS) return cached.footprint;
    if (running) return running;
    running = measureOnce(force);
    return running;
}

async function measureOnce(force: boolean): Promise<PolarisFootprint> {
    const driver = localDockerDriver();
    try {
        const footprint = await measure(driver, force);
        cached = { at: Date.now(), footprint };
        return footprint;
    } finally {
        await driver.dispose().catch(() => undefined);
        running = null;
    }
}

/** A usage sample the Containers table took this recently is as good as a new
 *  one: the table polls every five seconds, so on the page this card sits on
 *  there nearly always is one. */
const SAMPLE_REUSE_MS = 30_000;

/** How many volumes are measured at once. Each is a `du` inside a container,
 *  which walks a filesystem; a handful in parallel turns a stack's worth of them
 *  from a sum of waits into roughly the longest one, without asking the disk to
 *  walk every tree at once. */
const DU_CONCURRENCY = 4;

/**
 * CPU and memory for every container asked about. Samples the Containers table
 * already holds for the local engine are reused - sampling is a second-long wait
 * per container in the daemon - and only the containers it has none for are
 * read now, then remembered for the table. A forced reading samples them all.
 */
async function usageFor(
    driver: DockerDriver,
    containers: readonly ContainerSummary[],
    force: boolean
): Promise<Map<string, ContainerStats>> {
    const held = cachedSamples(LOCAL_DOCKER_CONNECTION_ID);
    const usage = new Map<string, ContainerStats>();
    const missing: ContainerSummary[] = [];
    for (const container of containers) {
        const sample = force ? undefined : held.get(container.id);
        if (sample && Date.now() - sample.at < SAMPLE_REUSE_MS) usage.set(container.id, sample.stats);
        else missing.push(container);
    }
    if (missing.length === 0) return usage;
    const fresh = await driver.statsMany(missing.map((container) => container.id));
    for (const container of missing) {
        const stats = fresh.get(container.id);
        if (!stats) continue;
        usage.set(container.id, stats);
        rememberSample(LOCAL_DOCKER_CONNECTION_ID, [container.id, container.name], stats);
    }
    return usage;
}

/** `work` over every item, at most `limit` at a time. */
async function eachLimited<T>(
    items: readonly T[],
    limit: number,
    work: (item: T) => Promise<void>
): Promise<void> {
    let next = 0;
    const lane = async (): Promise<void> => {
        while (next < items.length) {
            const item = items[next] as T;
            next += 1;
            await work(item);
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
}

async function measure(driver: DockerDriver, force: boolean): Promise<PolarisFootprint> {
    const all = await driver.listContainers(true);
    const own = all.filter(isPolarisPart);
    const running = own.filter((container) => container.state === "running");
    // Everything else that is running: what Polaris deploys, what was installed
    // through it, and anything started on the box by hand. Read in the same pass
    // and the same batch as the parts, so the two halves of the machine are
    // measured a moment apart rather than a request apart.
    const rest = all.filter(
        (container) => container.state === "running" && !isPolarisPart(container)
    );
    // One round trip for everything that only needs the listing: the engine,
    // usage, and one inspect per part for what it has written and what its image
    // weighs (`size` is the whole reason to ask: the fields are absent without
    // it). The inspects used to wait for the stats pass for no reason but the
    // order they were written in.
    const [info, stats, inspected] = await Promise.all([
        driver.info().catch(() => null),
        usageFor(driver, [...running, ...rest], force),
        Promise.all(
            own.map(
                async (container) =>
                    [
                        container.id,
                        await driver.inspect(container.id, { size: true }).catch(() => null)
                    ] as const
            )
        )
    ]);
    const details = new Map(inspected);

    // Volumes are measured from inside the container that mounts them, which is
    // the one place a named volume has a path at all. Once each: several parts
    // mount the same volume, and counting it twice would report a stack twice the
    // size of the one on disk. A stopped part cannot be asked, and a read-only
    // mount is somebody else's volume seen from here - so each volume is measured
    // through the first running part that mounts it writable, or not at all.
    /** Every named volume the stack mounts, measured or not - which is what says
     *  whether the disk figures are a total or a floor. */
    const seen = new Set<string>();
    const plan = new Map<string, { container: string; path: string }>();
    const parts: FootprintPart[] = [];
    for (const container of own) {
        const detail = details.get(container.id) ?? null;
        const sample = stats.get(container.id) ?? null;
        const volumes: FootprintVolume[] = [];
        for (const mount of detail?.mounts ?? []) {
            if (!mount.name) continue;
            seen.add(mount.name);
            if (!plan.has(mount.name) && container.state === "running" && mount.rw) {
                plan.set(mount.name, { container: container.name, path: mount.destination });
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
                detail && detail.sizeRootFs !== null
                    ? Math.max(0, detail.sizeRootFs - (detail.sizeRw ?? 0))
                    : null,
            volumes
        });
    }

    // Measured side by side rather than one after another, which is what made
    // this card the slowest thing on the page: one `du` per volume, in series.
    /** Only the readings that came back: a failed attempt leaves its volume
     *  unmeasured, which is what keeps the disk figure honest about being a floor. */
    const measured = new Map<string, number>();
    const ports = new HostdPorts();
    try {
        await eachLimited([...plan], DU_CONCURRENCY, async ([name, target]) => {
            const used = await ports.diskUsage(target.container, target.path);
            if (used !== null) measured.set(name, used);
        });
    } finally {
        await ports.dispose().catch(() => undefined);
    }
    // Filled in once every part has been walked, so a volume a stopped part
    // mounts still carries the figure the running part that shares it measured,
    // whichever of the two the engine listed first.
    const measuredParts = parts.map((part) => ({
        ...part,
        volumes: part.volumes.map((volume) => ({
            ...volume,
            usedBytes: measured.get(volume.name) ?? null
        }))
    }));

    // An image shared by two parts is one image on disk. Keyed by what the part
    // reports as its image, which is the same string for both.
    const images = new Map<string, number>();
    for (const part of measuredParts) {
        if (part.imageBytes !== null) images.set(part.image, part.imageBytes);
    }

    const restTotals: FootprintRest = {
        containers: rest.length,
        cpuPercent:
            Math.round(sum(rest.map((container) => stats.get(container.id)?.cpuPercent ?? null)) * 100) / 100,
        memUsedBytes: sum(rest.map((container) => stats.get(container.id)?.memUsage ?? null))
    };

    return {
        parts: measuredParts,
        rest: restTotals,
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
