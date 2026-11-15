/**
 * Readings history: which measures a device reports, when a sync's figure is
 * worth a stored sample, and how stored samples fold into a chart.
 *
 * Pure and client-safe: the device screen asks the same `measuresOf` the sync
 * records with, so a switch is never drawn for a measure nothing records, and a
 * measure that is recorded always has its switch.
 */

import { z } from "zod";
import { climateSettings, readingNumber } from "./device-kinds";
import { AIR_MEASURES, airSettings, filterLife } from "./air-kinds";

/** Every measure a history is kept for. `reading` is a sensor's figure in a
 *  unit none of the others names. */
export const READING_MEASURES = [
    "temperature",
    "humidity",
    "target",
    "pm25",
    "allergen",
    "gas",
    "filter",
    "power",
    "energy",
    "co2",
    "reading"
] as const;

export type ReadingMeasure = (typeof READING_MEASURES)[number];

export const readingMeasureSchema = z.enum(READING_MEASURES);

/** The windows the chart offers. */
export const READING_RANGES = ["24h", "7d", "30d", "1y"] as const;
export type ReadingRange = (typeof READING_RANGES)[number];
export const readingRangeSchema = z.enum(READING_RANGES);

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** How long each window is, and how wide one point on its chart is - so a
 *  year is 365 points and a day 144, never thousands. */
export const RANGE_SPAN: Readonly<Record<ReadingRange, { span: number; bucket: number }>> = {
    "24h": { span: DAY, bucket: 10 * MINUTE },
    "7d": { span: 7 * DAY, bucket: HOUR },
    "30d": { span: 30 * DAY, bucket: 6 * HOUR },
    "1y": { span: 365 * DAY, bucket: DAY }
};

/** Raw samples are kept this long, then folded into hours; hours are kept
 *  for the longest window plus a margin, then dropped. */
export const READINGS_RETENTION = { raw: 7 * DAY, hourly: 400 * DAY } as const;

/** An unchanged figure is stored again after this long, so a flat line on the
 *  chart is a figure that stayed put rather than a device nobody read. */
export const READING_HEARTBEAT_MS = 15 * MINUTE;
/** A changed figure is not stored more often than this per measure, so a
 *  sensor flickering between two values cannot write on every read. */
export const READING_MIN_GAP_MS = MINUTE;

/** The units each measure is drawn in. A sensor's `reading` uses its own. */
export const READING_UNITS: Readonly<Record<ReadingMeasure, string>> = {
    temperature: "°C",
    humidity: "%",
    target: "°C",
    pm25: "µg/m³",
    allergen: "",
    gas: "",
    filter: "%",
    power: "W",
    energy: "kWh",
    co2: "ppm",
    reading: ""
};

/** What the measures are read from: the device row as stored, or its view. */
export interface ReadingSource {
    readonly kind: string;
    readonly value: string | null;
    readonly unit: string | null;
    readonly climate?: unknown;
    readonly air?: unknown;
}

const AIR_KINDS = new Set(["air", "dehumidifier"]);

/** Which measure a bare figure in this unit is. */
function measureOfUnit(unit: string): ReadingMeasure {
    const clean = unit.trim().toLowerCase();
    if (clean === "°c" || clean === "c" || clean === "°f" || clean === "f") return "temperature";
    if (clean === "%" || clean === "% rh" || clean === "%rh") return "humidity";
    if (clean === "w") return "power";
    if (clean === "kwh") return "energy";
    if (clean === "ppm") return "co2";
    return "reading";
}

/**
 * Every measure the device reports right now, with its figure. Empty for a
 * device that measures nothing (a lock, a light, a socket without a meter).
 */
export function measuresOf(source: ReadingSource): Partial<Record<ReadingMeasure, number>> {
    const out: Partial<Record<ReadingMeasure, number>> = {};
    if (AIR_KINDS.has(source.kind)) {
        const air = airSettings(source.air);
        if (!air) return out;
        for (const measure of AIR_MEASURES) {
            const value = air.readings[measure];
            if (typeof value === "number" && Number.isFinite(value)) out[measure] = value;
        }
        const life = filterLife(air);
        if (life !== null) out.filter = life;
        return out;
    }
    const figure = readingNumber(source.value);
    if (source.kind === "climate") {
        // The room's temperature is the device's own reading; the target is
        // what it was set to, recorded so the two can be read side by side.
        if (figure !== null) out.temperature = figure;
        const target = climateSettings(source.climate)?.target;
        if (typeof target === "number") out.target = target;
        return out;
    }
    // A switch or a light's reading is a word ("on"); only a number is a measure.
    if (figure === null || !/^\s*-?\d+(?:[.,]\d+)?\s*$/.test(source.value ?? "")) return out;
    out[measureOfUnit(source.unit ?? "")] = figure;
    return out;
}

/** The measures whose history is kept, out of those reported: everything but
 *  what was switched off on the device. */
export function trackedMeasures(
    source: ReadingSource,
    off: readonly string[]
): Partial<Record<ReadingMeasure, number>> {
    const all = measuresOf(source);
    for (const measure of off) delete all[measure as ReadingMeasure];
    return all;
}

/** The last stored sample of one measure. */
export interface LastSample {
    readonly at: number;
    readonly value: number;
}

/**
 * Whether a figure read now is stored: always the first one, a changed one at
 * most once a minute, an unchanged one once per heartbeat.
 */
export function worthStoring(value: number, last: LastSample | undefined, now: number): boolean {
    if (!last) return true;
    const gap = now - last.at;
    if (gap < READING_MIN_GAP_MS) return false;
    if (value !== last.value) return true;
    return gap >= READING_HEARTBEAT_MS;
}

/** One stored point on a chart, or an hour folded from many. */
export interface ReadingBucket {
    readonly t: number;
    readonly avg: number;
    readonly min: number;
    readonly max: number;
    readonly count: number;
}

/**
 * Fold buckets onto a coarser grid: each lands in the window that holds its
 * start, the mean weighted by how many samples each carried.
 */
export function foldBuckets(buckets: readonly ReadingBucket[], width: number): ReadingBucket[] {
    const grid = new Map<number, { sum: number; min: number; max: number; count: number }>();
    for (const bucket of buckets) {
        if (bucket.count <= 0) continue;
        const t = Math.floor(bucket.t / width) * width;
        const slot = grid.get(t);
        if (!slot) {
            grid.set(t, {
                sum: bucket.avg * bucket.count,
                min: bucket.min,
                max: bucket.max,
                count: bucket.count
            });
            continue;
        }
        slot.sum += bucket.avg * bucket.count;
        slot.min = Math.min(slot.min, bucket.min);
        slot.max = Math.max(slot.max, bucket.max);
        slot.count += bucket.count;
    }
    return [...grid.entries()]
        .sort(([a], [b]) => a - b)
        .map(([t, slot]) => ({
            t,
            avg: slot.sum / slot.count,
            min: slot.min,
            max: slot.max,
            count: slot.count
        }));
}

/** The window's lowest, mean and highest, from its buckets. Null when empty. */
export function readingStats(
    buckets: readonly ReadingBucket[]
): { min: number; avg: number; max: number } | null {
    const [whole] = foldBuckets(buckets, Number.MAX_SAFE_INTEGER);
    return whole ? { min: whole.min, avg: whole.avg, max: whole.max } : null;
}

/** A measure's history for one window, as the chart draws it. */
export interface ReadingHistory {
    readonly measure: ReadingMeasure;
    readonly range: ReadingRange;
    readonly from: number;
    readonly to: number;
    readonly points: readonly ReadingBucket[];
    readonly stats: { min: number; avg: number; max: number } | null;
}

/** The sections of a device's page, top to bottom. */
export type DeviceSection = "controls" | "auto-off" | "used" | "readings" | "history";

/** Kinds whose worth is what the air or the room is doing: often left running,
 *  so how many times they were switched says little. */
const ENVIRONMENT_KINDS = new Set(["climate", "air", "dehumidifier", "sensor"]);
/** Kinds whose worth is being switched or opened: the count of uses is the
 *  point, whatever else they happen to measure. */
const SWITCHED_KINDS = new Set(["lock", "opener", "light", "switch", "outlet"]);
/** Measures of the room rather than of the device's own draw. */
const ENVIRONMENT_MEASURES: ReadonlySet<ReadingMeasure> = new Set([
    "temperature",
    "humidity",
    "target",
    "pm25",
    "allergen",
    "gas",
    "co2",
    "filter"
]);

/**
 * The order a device's page lists its sections in. The state and the controls
 * always lead and the history always closes. Between them, a device that reads
 * the room (a dehumidifier, a purifier, an air conditioner, a sensor) puts its
 * readings above the month of use, and a device that is switched (a light, a
 * socket, a door) keeps the use first. Any other kind reads the room first only
 * when it reports a measure of the room; a socket's watts never count.
 */
export function deviceSectionOrder(
    kind: string,
    measures: readonly ReadingMeasure[]
): readonly DeviceSection[] {
    const readingsFirst =
        !SWITCHED_KINDS.has(kind) &&
        measures.length > 0 &&
        (ENVIRONMENT_KINDS.has(kind) ||
            measures.some((measure) => ENVIRONMENT_MEASURES.has(measure)));
    return readingsFirst
        ? ["controls", "auto-off", "readings", "used", "history"]
        : ["controls", "auto-off", "used", "readings", "history"];
}
