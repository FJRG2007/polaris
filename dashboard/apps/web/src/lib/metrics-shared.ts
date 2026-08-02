/**
 * Shared constants and types for the metrics time-series feature (collection,
 * rollup, retention, and range resolution). Pure - no Prisma or driver imports -
 * so both the server services and client components can read it.
 */

export type MetricSubjectType = "app" | "storage" | "volume" | "host";

/**
 * Subject id for the machine Polaris itself runs on. It has no Host row until it
 * is enrolled, but it is the one server every install has - so it gets a fixed,
 * reserved id rather than being absent from its own monitoring. A uuid, because
 * the column is one.
 */
export const LOCAL_HOST_SUBJECT = "00000000-0000-4000-8000-000000000001";

/** One point of a series returned to the client. Bytes are plain numbers (a
 *  device's memory/disk stays well under 2^53), percentages are derived from the
 *  byte columns in the UI, never stored. */
export interface MetricPoint {
    /** Sample time, epoch milliseconds. */
    t: number;
    cpuPercent: number | null;
    cpuTempC: number | null;
    memUsedBytes: number | null;
    memTotalBytes: number | null;
    diskUsedBytes: number | null;
    diskTotalBytes: number | null;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

// Collection cadence (the loop ticks once per COLLECT_TICK_MS).
export const COLLECT_TICK_MS = 60_000;
/** Collect storage/NAS metrics every Nth tick (heavier than a container stat). */
export const STORAGE_EVERY_TICKS = 5;
/** Run rollup + purge every Nth tick (hourly). */
export const MAINTENANCE_EVERY_TICKS = 60;

// Retention windows: raw is kept just long enough to serve full-resolution
// ranges (up to RAW_MAX_SPAN_MS), rollups far longer for the wide ranges.
export const RAW_RETENTION_MS = 8 * DAY_MS;
export const ROLLUP_RETENTION_MS = 90 * DAY_MS;

/** At or below this span a read serves full-resolution raw; above it, the hourly
 *  rollups (so 7d/30d never scan the raw table). */
export const RAW_MAX_SPAN_MS = 48 * HOUR_MS;

/** Downsample raw to at most this many points per chart. */
export const MAX_POINTS = 240;

/** The preset ranges the UI offers, as span in milliseconds. */
export const RANGE_PRESETS = {
    "1h": HOUR_MS,
    "6h": 6 * HOUR_MS,
    "1d": DAY_MS,
    "7d": 7 * DAY_MS,
    "30d": 30 * DAY_MS
} as const;

export type RangePreset = keyof typeof RANGE_PRESETS;

export const RANGE_ORDER: RangePreset[] = ["1h", "6h", "1d", "7d", "30d"];

/**
 * How often a live chart re-fetches its window, per range.
 *
 * Paced against the collection cadence above rather than against how fresh it
 * would be nice to look: nothing new exists until the collector runs, so a
 * faster poll would only cost queries to redraw identical points. The wide
 * ranges read hourly rollups, which is why they back off so far.
 */
export const LIVE_INTERVAL_MS: Record<RangePreset, number> = {
    "1h": 30_000,
    "6h": 60_000,
    "1d": 2 * 60_000,
    "7d": 5 * 60_000,
    "30d": 15 * 60_000
};

/**
 * Resolve a requested window from query params: an explicit from/to (epoch ms,
 * custom range) wins when valid, otherwise a named preset (defaulting to 1d).
 * The window is clamped to the rollup retention so a custom range can never ask
 * for data that was already purged.
 */
export function resolveRange(
    rangeParam: string | null,
    fromParam: string | null,
    toParam: string | null,
    now: number = Date.now()
): { from: Date; to: Date } {
    if (fromParam && toParam) {
        const from = Number(fromParam);
        const to = Number(toParam);
        if (Number.isFinite(from) && Number.isFinite(to) && to > from) {
            const clampedFrom = Math.max(from, to - ROLLUP_RETENTION_MS);
            return { from: new Date(clampedFrom), to: new Date(to) };
        }
    }
    const span = RANGE_PRESETS[(rangeParam ?? "") as RangePreset] ?? RANGE_PRESETS["1d"];
    return { from: new Date(now - span), to: new Date(now) };
}
