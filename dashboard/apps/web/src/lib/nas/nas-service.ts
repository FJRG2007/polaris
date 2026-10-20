/**
 * A NAS as its Places page reads it: the console snapshot Drive already takes,
 * its fan profile and backup tasks, and its stored history - each read
 * separately, so a console that refuses one still shows the rest.
 *
 * Server-only. The console is signed in to with the account of whoever
 * connected the NAS, never the reader's, so a visitor drives it within their
 * grant without ever holding its password.
 */

import { prisma } from "@polaris/db";
import * as control from "@/lib/unifi-unas-control";
import { getUnasTarget } from "@/lib/storage-service";
import { fetchUnasMetrics, type UnasMetrics } from "@/lib/unifi-unas";
import { nasHistory, type NasPoint, type NasRange } from "./nas-history";
import type { NasDisk } from "./nas-view";

export { allDisks, type NasDisk } from "./nas-view";

export interface NasStatus {
    readonly name: string;
    readonly model: string;
    readonly firmware: string;
    readonly uptimeSeconds: number;
    readonly cpuTemp: number | null;
    readonly cpuLoad: number | null;
    readonly memoryUsedBytes: number;
    readonly memoryTotalBytes: number;
    readonly usedBytes: number;
    readonly totalBytes: number;
    readonly health: string;
    readonly pools: UnasMetrics["pools"];
    readonly disks: NasDisk[];
}

export type Part<T> = { readonly ok: true; readonly value: T } | { readonly ok: false };

export interface NasAnswer {
    readonly status: Part<NasStatus>;
    readonly fan: Part<control.UnasFanProfile | null>;
    readonly tasks: Part<control.UnasBackupTask[]>;
    readonly history: NasPoint[];
}

/** What the page draws from a snapshot. Pure; `visitor` drops serials. */
export function statusOf(metrics: UnasMetrics, visitor: boolean): NasStatus {
    const singlePool = metrics.pools.length === 1 ? metrics.pools[0]!.device : null;
    return {
        ...metrics.system,
        usedBytes: metrics.usedBytes,
        totalBytes: metrics.totalBytes,
        health: metrics.health,
        pools: metrics.pools,
        disks: metrics.disks.map((disk) => ({
            slot: disk.slot,
            present: disk.present,
            state: disk.state,
            model: disk.model,
            serial: visitor ? null : disk.serial,
            sizeBytes: disk.sizeBytes,
            temperature: disk.temperature,
            healthy: disk.healthy,
            powerOnHours: disk.powerOnHours,
            // The snapshot does not say which pool a bay is in; with one pool
            // every present drive is in it, and with more it is left unsaid.
            pool: disk.present ? singlePool : null
        }))
    };
}

/** The connection a NAS page is about, or null when there is no such NAS. */
export async function nasRow(connectionId: string) {
    return prisma.storageConnection.findFirst({
        where: { id: connectionId, kind: "unifi-unas" },
        select: { id: true, name: true, ownerId: true, placeId: true }
    });
}

async function part<T>(read: () => Promise<T>): Promise<Part<T>> {
    try {
        return { ok: true, value: await read() };
    } catch {
        return { ok: false };
    }
}

/** Everything the page shows. Callers check the reader's standing first. */
export async function readNas(
    connectionId: string,
    ownerId: string,
    range: NasRange,
    visitor: boolean
): Promise<NasAnswer> {
    const target = await part(() => getUnasTarget(connectionId, ownerId));
    if (!target.ok) {
        return {
            status: { ok: false },
            fan: { ok: false },
            tasks: { ok: false },
            history: await nasHistory(connectionId, range)
        };
    }
    const [status, fan, tasks, history] = await Promise.all([
        part(async () => statusOf(await fetchUnasMetrics(target.value), visitor)),
        part(() => control.readFanProfile(target.value)),
        part(() => control.listBackupTasks(target.value)),
        nasHistory(connectionId, range)
    ]);
    return { status, fan, tasks, history };
}

export async function setNasFan(
    connectionId: string,
    ownerId: string,
    profile: control.UnasFanProfile
): Promise<void> {
    await control.writeFanProfile(await getUnasTarget(connectionId, ownerId), profile);
}

export async function runNasBackup(
    connectionId: string,
    ownerId: string,
    taskId: string
): Promise<void> {
    const target = await getUnasTarget(connectionId, ownerId);
    // Only a task this NAS lists: an id from the browser is never sent on as-is
    // to a path it did not come from.
    const tasks = await control.listBackupTasks(target);
    if (!tasks.some((task) => task.id === taskId)) throw new Error("notFound");
    await control.runBackupTask(target, taskId);
}

export async function setNasPlace(connectionId: string, placeId: string | null): Promise<boolean> {
    if (placeId) {
        const place = await prisma.place.findUnique({ where: { id: placeId }, select: { id: true } });
        if (!place) return false;
    }
    const updated = await prisma.storageConnection.updateMany({
        where: { id: connectionId, kind: "unifi-unas" },
        data: { placeId }
    });
    return updated.count === 1;
}
