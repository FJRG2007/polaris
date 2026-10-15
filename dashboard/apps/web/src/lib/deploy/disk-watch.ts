/**
 * Watching the free space on every machine Polaris deploys to, early enough to
 * matter.
 *
 * The housekeeping sweep hands room back at 85% and tells the administrators of
 * this box at 90%. Neither is a warning a person sees in time: a server Polaris
 * deploys to was never reported at all, and a host was found at 99% with its
 * database crash-looping on "No space left on device". What fills a disk is
 * builds, and builds come in gigabytes, so a percentage alone says too late on a
 * large disk - 10% of a terabyte is a lot of room, 10% of 40 GB is two builds.
 *
 * So each machine is read on a short timer and given a level from both its free
 * share and its free bytes. The reading - with what is using the room - is kept,
 * so the dashboard can show it without reaching every server on every page view,
 * and a machine that is low is swept of what Polaris can safely remove on the
 * spot: old release images and build cache. Never a volume.
 *
 * Server-only.
 */

import { prisma, VISIBLE_USER } from "@polaris/db";
import { localDisk } from "@/lib/deploy/local-disk";
import { notify } from "@/lib/notifications/dispatch";
import { getLocalServerName } from "@/lib/local-server";
import { wordsFor } from "@/lib/notifications/notice-words";
import { getSetting, setSetting } from "@/lib/setting-store";
import { ImageStoreBusy, LOCAL_MACHINE } from "@/lib/deploy/image-store-lock";
import { hostSpace, reclaimHostSpace } from "@/lib/deploy/host-space";
import { parseEngineSize, sweepReleaseImages } from "@/lib/deploy/release-retention";
import {
    DF_ROOT,
    onServer,
    reclaimServerSpace,
    serversWithDeployments
} from "@/lib/deploy/server-space";

const GB = 1000 ** 3;

/** Under this share free, or under this many bytes free, a disk is low. */
export const LOW_FREE_RATIO = 0.1;
export const LOW_FREE_BYTES = 5 * GB;
/** And under these, critical: the next build or a database checkpoint fails. */
export const CRITICAL_FREE_RATIO = 0.05;
export const CRITICAL_FREE_BYTES = 2 * GB;

export type DiskLevel = "ok" | "low" | "critical";

/**
 * How worried to be about a disk with `free` of `total` bytes left.
 *
 * The byte thresholds are capped at a quarter (low) and a tenth (critical) of
 * the disk, so a small disk is not reported as low for being small.
 */
export function diskLevel(free: number, total: number): DiskLevel {
    if (!(total > 0) || !(free >= 0)) return "ok";
    const ratio = free / total;
    if (ratio < CRITICAL_FREE_RATIO || free < Math.min(CRITICAL_FREE_BYTES, total * 0.1))
        return "critical";
    if (ratio < LOW_FREE_RATIO || free < Math.min(LOW_FREE_BYTES, total * 0.25)) return "low";
    return "ok";
}

const RANK: Record<DiskLevel, number> = { ok: 0, low: 1, critical: 2 };

/** Whether moving from `before` to `after` is news worth telling somebody. */
export function worsened(before: DiskLevel | undefined, after: DiskLevel): boolean {
    return RANK[after] > RANK[before ?? "ok"];
}

/** What is using a machine's container store, in bytes. */
export interface DiskUsage {
    readonly images: number;
    readonly buildCache: number;
    readonly volumes: number;
    readonly containers: number;
    /** What Polaris can hand back without touching a volume - an estimate. */
    readonly reclaimable: number;
}

/** One machine's disk, as last read. */
export interface DiskReading {
    /** `local`, or the host's id. */
    readonly machine: string;
    /** Null for this box when it was never named; the screen says "this server". */
    readonly name: string | null;
    readonly total: number;
    readonly free: number;
    readonly level: DiskLevel;
    readonly usage: DiskUsage | null;
    readonly checkedAt: string;
}

const KEY = "deploy.diskWatch";

/** `df -P /` as free and total bytes, or null. */
export function diskFromDf(said: string): { free: number; total: number } | null {
    const line = said
        .split("\n")
        .map((row) => row.trim())
        .filter((row) => row !== "")
        .at(-1);
    if (!line) return null;
    // device, 1024-blocks, used, available, capacity%, mount
    const columns = line.split(/\s+/);
    const used = Number(columns[2]);
    const available = Number(columns[3]);
    if (!Number.isFinite(used) || !Number.isFinite(available) || used + available <= 0) return null;
    return { free: available * 1024, total: (used + available) * 1024 };
}

/** What a server's engine says it holds. */
export const SYSTEM_DF =
    "docker system df --format '{{.Type}}|{{.Size}}|{{.Reclaimable}}' 2>/dev/null";

/** `docker system df` as usage, or null when it printed nothing usable. */
export function usageFromSystemDf(said: string): DiskUsage | null {
    const rows = new Map<string, { size: number; reclaimable: number }>();
    for (const line of said.split("\n")) {
        const [type = "", size = "", reclaimable = ""] = line.trim().split("|");
        if (!type) continue;
        rows.set(type.toLowerCase(), {
            size: parseEngineSize(size),
            reclaimable: parseEngineSize(reclaimable.split(" ")[0] ?? "")
        });
    }
    if (rows.size === 0) return null;
    const images = rows.get("images");
    const cache = rows.get("build cache");
    return {
        images: images?.size ?? 0,
        buildCache: cache?.size ?? 0,
        volumes: rows.get("local volumes")?.size ?? 0,
        containers: rows.get("containers")?.size ?? 0,
        reclaimable: (images?.reclaimable ?? 0) + (cache?.reclaimable ?? 0)
    };
}

async function readLocal(): Promise<DiskReading | null> {
    const disk = await localDisk();
    if (!disk) return null;
    const free = Math.max(0, disk.total - disk.used);
    const space = await hostSpace().catch(() => null);
    return {
        machine: LOCAL_MACHINE,
        name: await getLocalServerName().catch(() => null),
        total: disk.total,
        free,
        level: diskLevel(free, disk.total),
        usage: space
            ? {
                  images: space.images,
                  buildCache: space.buildCache,
                  volumes: space.volumes,
                  containers: space.containers,
                  reclaimable: space.reclaimable
              }
            : null,
        checkedAt: new Date().toISOString()
    };
}

async function readServer(server: { id: string; name: string }): Promise<DiskReading | null> {
    const said = await onServer(server.id, DF_ROOT);
    const disk = said ? diskFromDf(said) : null;
    if (!disk) return null;
    const usage = await onServer(server.id, SYSTEM_DF).then((out) =>
        out ? usageFromSystemDf(out) : null
    );
    return {
        machine: server.id,
        name: server.name,
        ...disk,
        level: diskLevel(disk.free, disk.total),
        usage,
        checkedAt: new Date().toISOString()
    };
}

/** One machine read now: `local`, or a host Polaris deploys to. */
export async function readDisk(machine: string): Promise<DiskReading | null> {
    if (machine === LOCAL_MACHINE) return readLocal();
    const server = (await serversWithDeployments()).find((one) => one.id === machine);
    return server ? readServer(server) : null;
}

/** The last readings, as kept. */
export async function lastDiskReadings(): Promise<DiskReading[]> {
    const raw = await getSetting(KEY).catch(() => null);
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw) as unknown;
        return Array.isArray(parsed) ? (parsed as DiskReading[]) : [];
    } catch {
        return [];
    }
}

/** Replace one machine's reading in what is kept. */
export async function keepDiskReading(reading: DiskReading): Promise<void> {
    const kept = (await lastDiskReadings()).filter((one) => one.machine !== reading.machine);
    await setSetting(KEY, JSON.stringify([...kept, reading]));
}

/**
 * Hand back what Polaris can safely remove on one machine that is running out:
 * release images nothing can still want - the earlier ones kept only for a
 * rollback included, since only the serving and pinned ones are needed to run -
 * then build cache and images no container is on.
 * Never a volume. Returns the bytes freed, `busy` when nothing ran because a
 * deploy is fetching or building there, or null when the machine could not be
 * reached at all.
 */
export async function freeDiskSpace(machine: string): Promise<number | "busy" | null> {
    const releases = await sweepReleaseImages(machine, 0).catch(() => []);
    const fromReleases = releases.reduce((sum, one) => sum + one.freed, 0);
    let busy = releases.some((one) => one.busy);
    const reclaim =
        machine === LOCAL_MACHINE
            ? reclaimHostSpace({ whenIdle: true })
            : reclaimServerSpace(machine, { whenIdle: true });
    const reclaimed = await reclaim.catch((error: unknown) => {
        if (error instanceof ImageStoreBusy) busy = true;
        return null;
    });
    const freed = fromReleases + (reclaimed ?? 0);
    if (busy && freed === 0) return "busy";
    if (reclaimed === null && !releases.some((one) => one.ran)) return null;
    return freed;
}

/** Tell every administrator that a server Polaris deploys to is running out. */
async function tell(reading: DiskReading, freed: number | "busy" | null): Promise<void> {
    const body =
        freed === "busy"
            ? "disk.busyBody"
            : freed === null
              ? "disk.notFreedBody"
              : freed > 0
                ? "disk.lowBody"
                : "disk.nothingFreedBody";
    const admins = await prisma.user
        .findMany({ where: { isAdmin: true, ...VISIBLE_USER }, select: { id: true } })
        .catch(() => []);
    await Promise.allSettled(
        admins.map(async (admin) => {
            const t = await wordsFor(admin.id, "notices");
            return notify({
                userId: admin.id,
                event: "server.space",
                title: t(reading.level === "critical" ? "disk.criticalTitle" : "disk.lowTitle", {
                    server: reading.name ?? "",
                    free: `${(reading.free / GB).toFixed(1)} GB`
                }),
                body: t(body),
                audience: "admins",
                actionRequired: true,
                href: "/apps/servers"
            });
        })
    );
}

/**
 * Read every machine, free what can be freed on any that is low, keep the
 * readings, and tell the administrators about a server that got worse.
 *
 * This box is told about by the housekeeping sweep already (`host-housekeeping`),
 * so it is read and shown here but not announced twice.
 */
export async function watchDisks(): Promise<DiskReading[]> {
    const last = new Map((await lastDiskReadings()).map((one) => [one.machine, one]));
    const servers = await serversWithDeployments().catch(() => []);
    const readings: DiskReading[] = [];
    const machines = [
        { id: LOCAL_MACHINE, read: () => readLocal() },
        ...servers.map((server) => ({ id: server.id, read: () => readServer(server) }))
    ];
    for (const machine of machines) {
        let reading = await machine.read().catch(() => null);
        if (!reading) {
            const kept = last.get(machine.id);
            if (kept) readings.push(kept);
            continue;
        }
        let freed: number | "busy" | null = null;
        if (reading.level !== "ok") {
            freed = await freeDiskSpace(reading.machine).catch(() => null);
            if (typeof freed === "number" && freed > 0)
                reading = (await readDisk(reading.machine).catch(() => null)) ?? reading;
        }
        if (
            reading.machine !== LOCAL_MACHINE &&
            worsened(last.get(reading.machine)?.level, reading.level)
        ) {
            await tell(reading, freed).catch((error: unknown) => {
                console.error("polaris: could not report a server running out of disk:", error);
            });
        }
        readings.push(reading);
    }
    await setSetting(KEY, JSON.stringify(readings));
    return readings;
}
