/**
 * The statistics behind server insights, as pure functions over plain points.
 *
 * Kept free of the database and of React so each one can be checked with a
 * handful of numbers. Everything here is deliberately simple enough to be said in
 * a sentence on screen: a value is unusual when it sits far from the median of the
 * hours before it, measured in that window's own typical spread (the median
 * absolute deviation), and a disk's fill date is a straight line drawn through the
 * last days of readings.
 */

/** A value at a time; null is a gap. */
export interface SeriesPoint {
    t: number;
    v: number | null;
}

/** A value that is there. */
export interface ValuePoint {
    t: number;
    v: number;
}

/**
 * Fold a series into fixed buckets, averaging what each one holds.
 *
 * Buckets start at a multiple of `bucketMs` (UTC-aligned for an hour or a day),
 * gaps are skipped rather than averaged in as zero, and an empty bucket is left
 * out rather than reported as a value. The result is sorted by time.
 */
export function bucketize(points: readonly SeriesPoint[], bucketMs: number): ValuePoint[] {
    if (bucketMs <= 0) throw new Error("bucketMs must be positive");
    const sums = new Map<number, { sum: number; count: number }>();
    for (const point of points) {
        if (point.v == null || !Number.isFinite(point.v)) continue;
        const start = Math.floor(point.t / bucketMs) * bucketMs;
        const slot = sums.get(start) ?? { sum: 0, count: 0 };
        slot.sum += point.v;
        slot.count += 1;
        sums.set(start, slot);
    }
    return [...sums.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([t, slot]) => ({ t, v: slot.sum / slot.count }));
}

/** The median of a non-empty list; NaN for an empty one. */
export function median(values: readonly number[]): number {
    if (values.length === 0) return Number.NaN;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** Scales a median absolute deviation to a standard deviation for normal data. */
const MAD_SCALE = 1.4826;

export interface AnomalyOptions {
    /** How many earlier points make up "normal". */
    window: number;
    /** How few earlier points are still enough to judge by. */
    minHistory: number;
    /** How many robust deviations away a point has to be. */
    threshold: number;
    /** The smallest difference from normal worth reporting, in the metric's own
     *  units - a line that never moves would otherwise call every wobble unusual. */
    minDelta: number;
}

/** A stretch of consecutive unusual points on one side of normal. */
export interface AnomalyEpisode {
    /** First and last unusual point (epoch ms). */
    start: number;
    end: number;
    direction: "high" | "low";
    /** The point furthest from normal. */
    peakAt: number;
    peakValue: number;
    /** What normal was before the peak: the median of the window. */
    baseline: number;
    /** How far the peak was from normal, in robust deviations. */
    score: number;
}

/**
 * Unusual stretches in a series, by rolling median and MAD.
 *
 * Each point is judged against the `window` points before it - never itself, so
 * a spike cannot hide inside its own baseline. Points flagged one after another
 * on the same side merge into one episode, reported by its worst point, so a
 * three-hour surge is one line rather than three.
 */
export function detectAnomalies(points: readonly ValuePoint[], options: AnomalyOptions): AnomalyEpisode[] {
    const episodes: AnomalyEpisode[] = [];
    let current: AnomalyEpisode | null = null;
    for (let index = options.minHistory; index < points.length; index += 1) {
        const history = points.slice(Math.max(0, index - options.window), index).map((point) => point.v);
        const point = points[index]!;
        const center = median(history);
        const spread = median(history.map((value) => Math.abs(value - center))) * MAD_SCALE;
        const delta = point.v - center;
        // A flat history has no spread at all; the floor keeps the score finite
        // and lets minDelta decide whether the move is worth a line.
        const scale = Math.max(spread, options.minDelta / options.threshold, Number.EPSILON);
        const score = Math.abs(delta) / scale;
        const unusual = score >= options.threshold && Math.abs(delta) >= options.minDelta;
        const direction = delta >= 0 ? "high" : "low";
        if (!unusual) {
            current = null;
            continue;
        }
        if (current && current.direction === direction) {
            current.end = point.t;
            if (score > current.score) {
                current.peakAt = point.t;
                current.peakValue = point.v;
                current.baseline = center;
                current.score = score;
            }
            continue;
        }
        current = {
            start: point.t,
            end: point.t,
            direction,
            peakAt: point.t,
            peakValue: point.v,
            baseline: center,
            score
        };
        episodes.push(current);
    }
    return episodes;
}

/** A disk reading: bytes used of bytes in all. */
export interface DiskPoint {
    t: number;
    used: number;
    total: number;
}

const DAY_MS = 86_400_000;

export interface ForecastOptions {
    /** The least stretch of history a trend is drawn from, in days. */
    minSpanDays: number;
    /** The fewest readings a trend is drawn from. */
    minPoints: number;
    /** Growth below this share of the disk per day counts as flat. */
    flatShare: number;
}

export const FORECAST_DEFAULTS: ForecastOptions = { minSpanDays: 2, minPoints: 24, flatShare: 0.0005 };

export type DiskForecast =
    /** Too little history to draw a line through. */
    | { kind: "insufficient"; spanDays: number; usedBytes: number | null; totalBytes: number | null }
    /** Already full. */
    | { kind: "full"; usedBytes: number; totalBytes: number; bytesPerDay: number }
    /** Not growing, or shrinking. */
    | { kind: "steady"; usedBytes: number; totalBytes: number; bytesPerDay: number; spanDays: number }
    /** Growing: full in `days` if the trend holds. */
    | { kind: "filling"; usedBytes: number; totalBytes: number; bytesPerDay: number; spanDays: number; days: number };

/**
 * When a disk fills, by least-squares line through its readings.
 *
 * The line gives the rate; the room left is measured from the latest reading
 * rather than from the line, because the latest reading is what the disk holds
 * now. A disk whose size changed (it was grown) is judged against its latest
 * size. Says so plainly when the history is too short to mean anything.
 */
export function forecastDisk(
    points: readonly DiskPoint[],
    options: ForecastOptions = FORECAST_DEFAULTS
): DiskForecast {
    const usable = points.filter(
        (point) => Number.isFinite(point.used) && Number.isFinite(point.total) && point.total > 0
    );
    const last = usable[usable.length - 1];
    const spanDays = usable.length > 1 ? (last!.t - usable[0]!.t) / DAY_MS : 0;
    if (!last || usable.length < options.minPoints || spanDays < options.minSpanDays) {
        return {
            kind: "insufficient",
            spanDays,
            usedBytes: last?.used ?? null,
            totalBytes: last?.total ?? null
        };
    }
    const bytesPerDay = slopePerDay(usable);
    if (last.used >= last.total) {
        return { kind: "full", usedBytes: last.used, totalBytes: last.total, bytesPerDay };
    }
    if (bytesPerDay <= last.total * options.flatShare) {
        return { kind: "steady", usedBytes: last.used, totalBytes: last.total, bytesPerDay, spanDays };
    }
    return {
        kind: "filling",
        usedBytes: last.used,
        totalBytes: last.total,
        bytesPerDay,
        spanDays,
        days: (last.total - last.used) / bytesPerDay
    };
}

/** Ordinary least-squares slope of used bytes over time, per day. */
export function slopePerDay(points: readonly { t: number; used: number }[]): number {
    const n = points.length;
    if (n < 2) return 0;
    const origin = points[0]!.t;
    let sumX = 0;
    let sumY = 0;
    for (const point of points) {
        sumX += (point.t - origin) / DAY_MS;
        sumY += point.used;
    }
    const meanX = sumX / n;
    const meanY = sumY / n;
    let numerator = 0;
    let denominator = 0;
    for (const point of points) {
        const dx = (point.t - origin) / DAY_MS - meanX;
        numerator += dx * (point.used - meanY);
        denominator += dx * dx;
    }
    return denominator === 0 ? 0 : numerator / denominator;
}
