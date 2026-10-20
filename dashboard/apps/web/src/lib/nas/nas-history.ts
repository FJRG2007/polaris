/**
 * A NAS's chart history: one reading per storage tick (every five minutes, the
 * cadence Drive already polls the console at), kept a little over a month so
 * the widest range - 1M - is whole, and read back bucketed for a chart.
 *
 * What is stored is only what the console snapshot really carries: CPU and
 * per-bay disk temperatures, and pool usage. Disk throughput is not in that
 * snapshot (the plugin agent reads it from /proc/diskstats on the device), so
 * there is no throughput series here rather than an invented one.
 */

import { z } from "zod";
import { prisma } from "@polaris/db";
import type { UnasMetrics } from "@/lib/unifi-unas";
import { NAS_RANGES, NAS_RANGE_MS, type NasRange } from "./nas-view";

export { NAS_RANGES, NAS_RANGE_MS, type NasRange } from "./nas-view";

export const nasRangeSchema = z.enum(NAS_RANGES);

const HOUR_MS = 60 * 60 * 1000;

/** One more than the widest range, so 1M never starts on a hole. */
export const NAS_SAMPLE_RETENTION_DAYS = 31;
/** The most points one series is drawn with. */
export const NAS_MAX_POINTS = 240;
/** The most rows one read takes: 31 days at one every five minutes, with room. */
const MAX_ROWS = 10_000;

export interface NasSampleRow {
    readonly ts: Date;
    readonly cpuTempC: number | null;
    readonly diskTempMaxC: number | null;
    readonly diskTempAvgC: number | null;
    readonly usedBytes: bigint | null;
    readonly totalBytes: bigint | null;
    readonly diskTemps: unknown;
}

export interface NasPoint {
    readonly t: number;
    readonly cpuTempC: number | null;
    readonly diskTempMaxC: number | null;
    readonly diskTempAvgC: number | null;
    readonly usedPercent: number | null;
    /** Bay number (as a string key) -> average temperature in the bucket. */
    readonly bays: Record<string, number>;
}

/** The row one metrics snapshot is stored as. */
export function sampleOf(metrics: UnasMetrics): Omit<NasSampleRow, "ts"> {
    const temps = metrics.disks
        .filter((disk) => disk.present && disk.temperature !== null)
        .map((disk) => [disk.slot, disk.temperature as number] as const);
    const values = temps.map(([, temp]) => temp);
    return {
        cpuTempC: metrics.system.cpuTemp,
        diskTempMaxC: values.length > 0 ? Math.max(...values) : null,
        diskTempAvgC:
            values.length > 0 ? round1(values.reduce((a, b) => a + b, 0) / values.length) : null,
        usedBytes: BigInt(Math.max(0, Math.round(metrics.usedBytes))),
        totalBytes: BigInt(Math.max(0, Math.round(metrics.totalBytes))),
        diskTemps: Object.fromEntries(temps.map(([slot, temp]) => [String(slot), temp]))
    };
}

function round1(value: number): number {
    return Math.round(value * 10) / 10;
}

function mean(values: readonly (number | null)[]): number | null {
    const present = values.filter((value): value is number => value !== null);
    return present.length > 0 ? round1(present.reduce((a, b) => a + b, 0) / present.length) : null;
}

function bayTemps(value: unknown): Record<string, number> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
    return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).filter(
            (entry): entry is [string, number] =>
                typeof entry[1] === "number" && Number.isFinite(entry[1])
        )
    );
}

/**
 * Rows to at most `max` points: fixed-width time buckets across the range,
 * each the average of the readings inside it; a bucket with none is left out,
 * so a gap in the readings is a gap in the line.
 */
export function bucketSamples(
    rows: readonly NasSampleRow[],
    from: number,
    to: number,
    max = NAS_MAX_POINTS
): NasPoint[] {
    const width = Math.max(1, Math.ceil((to - from) / max));
    const buckets = new Map<number, NasSampleRow[]>();
    for (const row of rows) {
        const t = row.ts.getTime();
        if (t < from || t > to) continue;
        const index = Math.min(max - 1, Math.floor((t - from) / width));
        const list = buckets.get(index) ?? [];
        list.push(row);
        buckets.set(index, list);
    }
    return [...buckets.entries()]
        .sort(([a], [b]) => a - b)
        .map(([index, list]) => {
            const bays = new Map<string, number[]>();
            for (const row of list) {
                for (const [bay, temp] of Object.entries(bayTemps(row.diskTemps))) {
                    bays.set(bay, [...(bays.get(bay) ?? []), temp]);
                }
            }
            const used = list.map((row) =>
                row.usedBytes !== null && row.totalBytes !== null && row.totalBytes > 0n
                    ? (Number(row.usedBytes) / Number(row.totalBytes)) * 100
                    : null
            );
            return {
                t: from + index * width + Math.floor(width / 2),
                cpuTempC: mean(list.map((row) => row.cpuTempC)),
                diskTempMaxC: mean(list.map((row) => row.diskTempMaxC)),
                diskTempAvgC: mean(list.map((row) => row.diskTempAvgC)),
                usedPercent: mean(used),
                bays: Object.fromEntries(
                    [...bays.entries()].map(([bay, temps]) => [bay, mean(temps) as number])
                )
            };
        });
}

/** Store one snapshot. The storage tick is the only writer, so one per tick. */
export async function recordNasSample(
    connectionId: string,
    metrics: UnasMetrics,
    ts: Date
): Promise<void> {
    const row = sampleOf(metrics);
    await prisma.nasSample.create({
        data: { connectionId, ts, ...row, diskTemps: row.diskTemps as object }
    });
}

let lastPrune = 0;
const PRUNE_EVERY_MS = HOUR_MS;

/** Readings past retention, every NAS at once. Hourly at most. */
export async function pruneNasSamples(now: number): Promise<void> {
    if (now - lastPrune < PRUNE_EVERY_MS) return;
    lastPrune = now;
    await prisma.nasSample.deleteMany({
        where: { ts: { lt: new Date(now - NAS_SAMPLE_RETENTION_DAYS * 24 * HOUR_MS) } }
    });
}

/** One NAS's chart points over a range, ending now. Callers check access first. */
export async function nasHistory(
    connectionId: string,
    range: NasRange,
    now = Date.now()
): Promise<NasPoint[]> {
    const from = now - NAS_RANGE_MS[range];
    const rows = await prisma.nasSample.findMany({
        where: { connectionId, ts: { gte: new Date(from) } },
        orderBy: { ts: "asc" },
        take: MAX_ROWS,
        select: {
            ts: true,
            cpuTempC: true,
            diskTempMaxC: true,
            diskTempAvgC: true,
            usedBytes: true,
            totalBytes: true,
            diskTemps: true
        }
    });
    return bucketSamples(rows, from, now);
}
