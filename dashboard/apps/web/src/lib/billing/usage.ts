/**
 * What a set of services and volumes used between two instants, read from the
 * metrics the collector already keeps.
 *
 * Two tables, one answer. The hourly rollups hold everything up to the last hour
 * the collector folded; the raw samples hold the hour or two since, which a
 * statement for the current month must not leave out. Those are folded into hours
 * here the same way the collector folds them, so both halves are metered by the
 * one pure function in `@polaris/core` and cannot disagree about what an hour is
 * worth.
 *
 * Read in pages and chunks and folded as it goes, so a month of an instance with
 * hundreds of services costs memory per service rather than per hour of each.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { COLLECT_TICK_MS, counterAdvance, STORAGE_EVERY_TICKS } from "@/lib/metrics-shared";

const HOUR_MS = 3_600_000;

/** Subjects asked about per query: keeps the id list of one statement well
 *  inside what a single query may bind. */
const CHUNK = 200;

/** Rows read per round trip. */
const PAGE = 5000;

/** How far back the raw samples are read for the hours not folded yet. The
 *  collector folds every hour, so anything past this is a collector that has
 *  stopped folding, and reading a week of raw samples would not fix that. */
const RAW_TAIL_MAX_MS = 6 * HOUR_MS;

/** How the collector samples, which is what turns a count of readings into time. */
export const METER_CADENCE: core.MeterCadence = {
    appSampleMinutes: COLLECT_TICK_MS / 60_000,
    volumeSampleMinutes: (COLLECT_TICK_MS * STORAGE_EVERY_TICKS) / 60_000
};

/** One thing to meter: a service, with the cores of the machine it runs on, or a
 *  volume. */
export interface MeteredSubject {
    readonly subjectType: "app" | "volume";
    readonly subjectId: string;
    /** The machine's core count, for a service; null when unknown or a volume. */
    readonly cores: number | null;
}

function toNumber(value: bigint | number | null): number | null {
    if (value === null) return null;
    return typeof value === "bigint" ? Number(value) : value;
}

function key(subjectType: string, subjectId: string): string {
    return `${subjectType}:${subjectId}`;
}

function chunks<T>(items: readonly T[], size: number): T[][] {
    const out: T[][] = [];
    for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
    return out;
}

function average(values: (number | null)[]): number | null {
    const present = values.filter((value): value is number => value !== null);
    return present.length === 0 ? null : present.reduce((sum, value) => sum + value, 0) / present.length;
}

/**
 * Every subject's usage over [from, to), by subject key (`app:<id>`,
 * `volume:<id>`). A subject that used nothing is absent.
 */
export async function meterSubjects(
    subjects: readonly MeteredSubject[],
    from: Date,
    to: Date
): Promise<Map<string, core.BillingUsage>> {
    const usage = new Map<string, core.BillingUsage>();
    if (subjects.length === 0 || to <= from) return usage;

    const cores = new Map(subjects.map((subject) => [key(subject.subjectType, subject.subjectId), subject.cores]));
    const add = (hour: core.UsageHour): void => {
        const id = key(hour.subjectType, hour.subjectId);
        const metered = core.meterHour(hour, cores.get(id) ?? null, METER_CADENCE);
        usage.set(id, core.addUsage(usage.get(id) ?? core.EMPTY_USAGE, metered));
    };

    // The rollups end at the last hour the collector folded; the raw samples
    // cover what came after it.
    const newest = await prisma.metricRollup.aggregate({ _max: { bucket: true } });
    const folded = newest._max.bucket ? newest._max.bucket.getTime() + HOUR_MS : from.getTime();
    const tailFrom = new Date(
        Math.min(to.getTime(), Math.max(from.getTime(), folded, to.getTime() - RAW_TAIL_MAX_MS))
    );

    for (const group of chunks(subjects, CHUNK)) {
        const apps = group.filter((subject) => subject.subjectType === "app").map((subject) => subject.subjectId);
        const volumes = group
            .filter((subject) => subject.subjectType === "volume")
            .map((subject) => subject.subjectId);
        const where = {
            OR: [
                ...(apps.length > 0 ? [{ subjectType: "app", subjectId: { in: apps } }] : []),
                ...(volumes.length > 0 ? [{ subjectType: "volume", subjectId: { in: volumes } }] : [])
            ]
        };

        if (tailFrom > from) await foldRollups(where, from, tailFrom, add);
        if (to > tailFrom) await foldRaw(where, tailFrom, to, add);
    }
    return usage;
}

type SubjectWhere = { OR: { subjectType: string; subjectId: { in: string[] } }[] };

/** The hourly rollups in [from, to), a page at a time. */
async function foldRollups(
    where: SubjectWhere,
    from: Date,
    to: Date,
    add: (hour: core.UsageHour) => void
): Promise<void> {
    let cursor: { subjectType: string; subjectId: string; bucket: Date } | null = null;
    for (;;) {
        const rows: {
            subjectType: string;
            subjectId: string;
            bucket: Date;
            cpuPercentAvg: number | null;
            memUsedBytesAvg: bigint | null;
            diskUsedBytesAvg: bigint | null;
            netTxBytesSum: bigint | null;
            samples: number;
        }[] = await prisma.metricRollup.findMany({
            where: { ...where, bucket: { gte: from, lt: to } },
            orderBy: [{ subjectType: "asc" }, { subjectId: "asc" }, { bucket: "asc" }],
            take: PAGE,
            ...(cursor ? { cursor: { subjectType_subjectId_bucket: cursor }, skip: 1 } : {}),
            select: {
                subjectType: true,
                subjectId: true,
                bucket: true,
                cpuPercentAvg: true,
                memUsedBytesAvg: true,
                diskUsedBytesAvg: true,
                netTxBytesSum: true,
                samples: true
            }
        });
        for (const row of rows) {
            add({
                subjectType: row.subjectType === "volume" ? "volume" : "app",
                subjectId: row.subjectId,
                cpuPercentAvg: row.cpuPercentAvg,
                memUsedBytesAvg: toNumber(row.memUsedBytesAvg),
                diskUsedBytesAvg: toNumber(row.diskUsedBytesAvg),
                netTxBytesSum: toNumber(row.netTxBytesSum),
                samples: row.samples
            });
        }
        const last = rows.at(-1);
        if (rows.length < PAGE || !last) return;
        cursor = { subjectType: last.subjectType, subjectId: last.subjectId, bucket: last.bucket };
    }
}

/**
 * The raw samples in [from, to), folded into hours the way the collector folds
 * them: averages for the gauges, how far the counter moved for the traffic, and
 * how many readings each hour was made of.
 */
async function foldRaw(
    where: SubjectWhere,
    from: Date,
    to: Date,
    add: (hour: core.UsageHour) => void
): Promise<void> {
    const rows = await prisma.metricSample.findMany({
        where: { ...where, ts: { gte: from, lt: to } },
        orderBy: [{ subjectType: "asc" }, { subjectId: "asc" }, { ts: "asc" }],
        select: {
            subjectType: true,
            subjectId: true,
            ts: true,
            cpuPercent: true,
            memUsedBytes: true,
            diskUsedBytes: true,
            netTxBytes: true
        }
    });

    const hours = new Map<string, typeof rows>();
    for (const row of rows) {
        const bucket = Math.floor(row.ts.getTime() / HOUR_MS) * HOUR_MS;
        const id = `${key(row.subjectType, row.subjectId)}:${bucket}`;
        const held = hours.get(id);
        if (held) held.push(row);
        else hours.set(id, [row]);
    }
    for (const list of hours.values()) {
        const first = list[0];
        if (!first) continue;
        const sent = counterAdvance(list.map((row) => row.netTxBytes));
        add({
            subjectType: first.subjectType === "volume" ? "volume" : "app",
            subjectId: first.subjectId,
            cpuPercentAvg: average(list.map((row) => row.cpuPercent)),
            memUsedBytesAvg: average(list.map((row) => toNumber(row.memUsedBytes))),
            diskUsedBytesAvg: average(list.map((row) => toNumber(row.diskUsedBytes))),
            netTxBytesSum: toNumber(sent),
            samples: list.length
        });
    }
}
