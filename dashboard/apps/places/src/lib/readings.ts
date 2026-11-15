/**
 * Readings history: stored on every sync, read by the device screen, folded and
 * trimmed by the readings sweep.
 *
 * Which measures a device has and whether a figure is worth a row are decided
 * in `reading-kinds.ts`; this module only moves rows. Every read goes through
 * `readingHistory`, which refuses a measure switched off on the device - so a
 * chart, an automation or an export that reads history cannot see one.
 */

import * as rk from "./reading-kinds";
import { HomeError } from "./home-error";
import { prisma } from "@polaris/db";

/** What a sync hands over: the device row as stored after it. */
export interface ReadingRow extends rk.ReadingSource {
    readonly id: string;
    readonly readingsOff?: readonly string[] | null;
}

/**
 * The last stored sample per device and measure, so a sync does not ask the
 * database for it every minute. A miss (a restart, another runner) is filled
 * from the table; a stale entry only costs one extra row, which the key on
 * (device, measure, at) keeps from doubling.
 */
const lastSamples = new Map<string, rk.LastSample>();
const LAST_SAMPLES_LIMIT = 50_000;

function sampleKey(deviceId: string, measure: string): string {
    return `${deviceId}:${measure}`;
}

async function loadLast(deviceIds: readonly string[]): Promise<void> {
    if (deviceIds.length === 0) return;
    const rows = await prisma.$queryRaw<{ deviceId: string; measure: string; at: Date; value: number }[]>`
        SELECT DISTINCT ON ("deviceId", "measure") "deviceId", "measure", "at", "value"
        FROM "PlaceDeviceReading"
        WHERE "deviceId" = ANY(${deviceIds}::uuid[])
          AND "at" > ${new Date(Date.now() - rk.READING_HEARTBEAT_MS)}
        ORDER BY "deviceId", "measure", "at" DESC`;
    for (const row of rows) {
        lastSamples.set(sampleKey(row.deviceId, row.measure), {
            at: row.at.getTime(),
            value: row.value
        });
    }
}

/** Forget what was cached, for tests and for a measure whose history went. */
export function forgetLastSamples(deviceId?: string, measure?: string): void {
    if (!deviceId) return lastSamples.clear();
    if (measure) {
        lastSamples.delete(sampleKey(deviceId, measure));
        return;
    }
    for (const key of [...lastSamples.keys()]) {
        if (key.startsWith(`${deviceId}:`)) lastSamples.delete(key);
    }
}

/** The rows a sync would write for these devices now, deduplicated. */
export function samplesFor(
    rows: readonly ReadingRow[],
    now: number,
    last: (deviceId: string, measure: string) => rk.LastSample | undefined
): { deviceId: string; measure: rk.ReadingMeasure; at: Date; value: number }[] {
    const out: { deviceId: string; measure: rk.ReadingMeasure; at: Date; value: number }[] = [];
    for (const row of rows) {
        const figures = rk.trackedMeasures(row, row.readingsOff ?? []);
        for (const [measure, value] of Object.entries(figures) as [rk.ReadingMeasure, number][]) {
            if (!rk.worthStoring(value, last(row.id, measure), now)) continue;
            out.push({ deviceId: row.id, measure, at: new Date(now), value });
        }
    }
    return out;
}

/**
 * Store what the devices just read, where it changed or the last one is old.
 * Never a reason for a sync to fail: the room was as warm whether or not the
 * history heard about it.
 */
export async function recordReadings(rows: readonly ReadingRow[]): Promise<void> {
    const measuring = rows.filter((row) => Object.keys(rk.measuresOf(row)).length > 0);
    if (measuring.length === 0) return;
    try {
        const missing = measuring
            .filter((row) => {
                const measures = Object.keys(rk.measuresOf(row));
                return measures.some((measure) => !lastSamples.has(sampleKey(row.id, measure)));
            })
            .map((row) => row.id);
        await loadLast(missing);
        const now = Date.now();
        const samples = samplesFor(measuring, now, (deviceId, measure) =>
            lastSamples.get(sampleKey(deviceId, measure))
        );
        if (samples.length === 0) return;
        await prisma.placeDeviceReading.createMany({ data: samples, skipDuplicates: true });
        if (lastSamples.size > LAST_SAMPLES_LIMIT) lastSamples.clear();
        for (const sample of samples) {
            lastSamples.set(sampleKey(sample.deviceId, sample.measure), {
                at: now,
                value: sample.value
            });
        }
    } catch (error) {
        console.error("places: a device's readings could not be stored:", error);
    }
}

type BucketRow = { t: number | bigint; avg: number; min: number; max: number; count: number | bigint };

function toBuckets(rows: readonly BucketRow[], width: number): rk.ReadingBucket[] {
    return rows.map((row) => ({
        t: Number(row.t) * width,
        avg: Number(row.avg),
        min: Number(row.min),
        max: Number(row.max),
        count: Number(row.count)
    }));
}

/**
 * One measure of one device over a window: raw samples where they are still
 * kept, hours before that, folded onto the window's grid in the database.
 * A measure switched off on the device has no history, whoever asks.
 */
export async function readingHistory(
    installedAppId: string,
    deviceId: string,
    measure: rk.ReadingMeasure,
    range: rk.ReadingRange,
    now = Date.now()
): Promise<rk.ReadingHistory> {
    const device = await prisma.placeDevice.findFirst({
        where: { id: deviceId, installedAppId },
        select: { readingsOff: true }
    });
    if (!device) throw new HomeError("That device is no longer connected");
    const { span, bucket } = rk.RANGE_SPAN[range];
    const from = now - span;
    if (device.readingsOff.includes(measure)) {
        return { measure, range, from, to: now, points: [], stats: null };
    }
    const seconds = bucket / 1000;
    const rawFrom = new Date(Math.max(from, now - rk.READINGS_RETENTION.raw));
    const [raw, hours] = await Promise.all([
        prisma.$queryRaw<BucketRow[]>`
            SELECT floor(extract(epoch FROM "at") / ${seconds})::bigint AS t,
                   avg("value") AS avg, min("value") AS min, max("value") AS max,
                   count(*)::bigint AS count
            FROM "PlaceDeviceReading"
            WHERE "deviceId" = ${deviceId}::uuid AND "measure" = ${measure}
              AND "at" >= ${rawFrom} AND "at" <= ${new Date(now)}
            GROUP BY 1 ORDER BY 1`,
        prisma.$queryRaw<BucketRow[]>`
            SELECT floor(extract(epoch FROM "hour") / ${seconds})::bigint AS t,
                   sum("avg" * "count") / sum("count") AS avg, min("min") AS min,
                   max("max") AS max, sum("count")::bigint AS count
            FROM "PlaceDeviceReadingHour"
            WHERE "deviceId" = ${deviceId}::uuid AND "measure" = ${measure}
              AND "hour" >= ${new Date(from)} AND "hour" <= ${new Date(now)}
            GROUP BY 1 ORDER BY 1`
    ]);
    const points = rk.foldBuckets(
        [...toBuckets(hours, bucket), ...toBuckets(raw, bucket)],
        bucket
    );
    return { measure, range, from, to: now, points, stats: rk.readingStats(points) };
}

/**
 * Switch one measure's history on or off. Off drops everything stored for it
 * in the same transaction, so a measure switched off for privacy is gone, not
 * hidden.
 */
export async function setReadingTracking(
    installedAppId: string,
    deviceId: string,
    measure: rk.ReadingMeasure,
    on: boolean
): Promise<string[]> {
    const device = await prisma.placeDevice.findFirst({
        where: { id: deviceId, installedAppId },
        select: { readingsOff: true }
    });
    if (!device) throw new HomeError("That device is no longer connected");
    const off = new Set(device.readingsOff);
    if (on) off.delete(measure);
    else off.add(measure);
    const next = [...off].filter((word) => rk.readingMeasureSchema.safeParse(word).success);
    if (on) {
        await prisma.placeDevice.update({ where: { id: deviceId }, data: { readingsOff: next } });
        return next;
    }
    await prisma.$transaction([
        prisma.placeDevice.update({ where: { id: deviceId }, data: { readingsOff: next } }),
        prisma.placeDeviceReading.deleteMany({ where: { deviceId, measure } }),
        prisma.placeDeviceReadingHour.deleteMany({ where: { deviceId, measure } })
    ]);
    forgetLastSamples(deviceId, measure);
    return next;
}

/** The start of the hour a time falls in. */
export function hourFloor(at: number): number {
    return Math.floor(at / 3_600_000) * 3_600_000;
}

/**
 * The readings sweep: raw samples older than a week are folded into their
 * hours and dropped, in one transaction so a failed pass neither loses nor
 * doubles a sample; hours past the retention are dropped. Only whole hours
 * are folded, and an hour folded twice (a sample that arrived late) merges.
 */
export async function sweepReadings(now = Date.now()): Promise<void> {
    const cutoff = new Date(hourFloor(now - rk.READINGS_RETENTION.raw));
    await prisma.$transaction([
        prisma.$executeRaw`
            INSERT INTO "PlaceDeviceReadingHour" ("deviceId", "measure", "hour", "avg", "min", "max", "count")
            SELECT "deviceId", "measure", date_trunc('hour', "at"), avg("value"), min("value"),
                   max("value"), count(*)::int
            FROM "PlaceDeviceReading"
            WHERE "at" < ${cutoff}
            GROUP BY 1, 2, 3
            ON CONFLICT ("deviceId", "measure", "hour") DO UPDATE SET
                "avg" = ("PlaceDeviceReadingHour"."avg" * "PlaceDeviceReadingHour"."count"
                         + EXCLUDED."avg" * EXCLUDED."count")
                        / ("PlaceDeviceReadingHour"."count" + EXCLUDED."count"),
                "min" = LEAST("PlaceDeviceReadingHour"."min", EXCLUDED."min"),
                "max" = GREATEST("PlaceDeviceReadingHour"."max", EXCLUDED."max"),
                "count" = "PlaceDeviceReadingHour"."count" + EXCLUDED."count"`,
        prisma.placeDeviceReading.deleteMany({ where: { at: { lt: cutoff } } })
    ]);
    await prisma.placeDeviceReadingHour.deleteMany({
        where: { hour: { lt: new Date(now - rk.READINGS_RETENTION.hourly) } }
    });
}
