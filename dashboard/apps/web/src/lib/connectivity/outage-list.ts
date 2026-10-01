/**
 * The Connectivity screen's list: which outages a set of filters keeps, how the
 * filters live in the address bar, and the CSV the export button hands over.
 *
 * Pure and browser-safe, so the rule the table applies and the rule the export
 * applies are one rule, and both can be asserted without a page.
 */

import { toCsv } from "@polaris/core";
import { effectiveEnd, isOutageKind, OUTAGE_KINDS, type OutageKind } from "./outages";

/** The fields of an outage the list reads; the server's `OutageView` has them all. */
export interface ListedOutage {
    readonly id: string;
    readonly kind: OutageKind;
    readonly startedAt: string;
    readonly endedAt: string | null;
    readonly lastSeenAt: string;
    readonly detectedBy: string | null;
    readonly detail: string | null;
    readonly firstBack: string | null;
    readonly closedBy: string | null;
    readonly blips: number;
}

export const RANGES = ["7d", "30d", "90d", "365d"] as const;
export type Range = (typeof RANGES)[number];
const RANGE_DAYS: Record<Range, number> = { "7d": 7, "30d": 30, "90d": 90, "365d": 365 };

export const MIN_LENGTHS = ["any", "1m", "10m", "1h"] as const;
export type MinLength = (typeof MIN_LENGTHS)[number];
const MIN_MS: Record<MinLength, number> = { any: 0, "1m": 60_000, "10m": 600_000, "1h": 3_600_000 };

export interface OutageFilters {
    /** Empty means every kind. */
    readonly kinds: readonly OutageKind[];
    readonly range: Range;
    readonly min: MinLength;
    /** One day picked on the heatmap, with its bounds in epoch ms. */
    readonly day: { readonly label: string; readonly start: number; readonly end: number } | null;
}

export const DEFAULT_FILTERS: OutageFilters = { kinds: [], range: "90d", min: "any", day: null };

/** How long an outage lasted, or has lasted so far. */
export function outageLength(outage: ListedOutage, now: number, staleMs: number): number {
    const start = Date.parse(outage.startedAt);
    const end = effectiveEnd(
        {
            startedAt: start,
            endedAt: outage.endedAt === null ? null : Date.parse(outage.endedAt),
            lastSeenAt: Date.parse(outage.lastSeenAt)
        },
        now,
        staleMs
    );
    return Math.max(0, end - start);
}

/**
 * The outages the filters keep, newest first as they came. AND across filters, OR
 * within the kinds. A picked day replaces the range: the reader asked about that
 * day, and an outage that touched it counts even if it started the day before.
 */
export function filterOutages<T extends ListedOutage>(
    outages: readonly T[],
    filters: OutageFilters,
    now: number,
    staleMs: number
): T[] {
    const from = now - RANGE_DAYS[filters.range] * 86_400_000;
    return outages.filter((outage) => {
        if (filters.kinds.length > 0 && !filters.kinds.includes(outage.kind)) return false;
        const length = outageLength(outage, now, staleMs);
        if (length < MIN_MS[filters.min]) return false;
        const start = Date.parse(outage.startedAt);
        const end = start + length;
        if (filters.day) return start < filters.day.end && end > filters.day.start;
        return end >= from;
    });
}

/** The filters as the query string carries them; the defaults are left out. */
export function filtersToQuery(filters: OutageFilters): Record<string, string> {
    const query: Record<string, string> = {};
    if (filters.kinds.length > 0) query.kind = filters.kinds.join(",");
    if (filters.range !== DEFAULT_FILTERS.range) query.range = filters.range;
    if (filters.min !== DEFAULT_FILTERS.min) query.min = filters.min;
    if (filters.day) query.day = filters.day.label;
    return query;
}

/**
 * The filters a query string asks for. Anything it cannot read falls back to the
 * default, so a hand-edited or old link opens the screen rather than an error.
 * A day is kept only when the caller can place it (`placeDay`), which is the
 * heatmap's own list of days.
 */
export function filtersFromQuery(
    read: (key: string) => string | null,
    placeDay: (label: string) => { start: number; end: number } | null
): OutageFilters {
    const kinds = (read("kind") ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(isOutageKind);
    const range = read("range");
    const min = read("min");
    const dayLabel = read("day");
    const placed = dayLabel && /^\d{4}-\d{2}-\d{2}$/.test(dayLabel) ? placeDay(dayLabel) : null;
    return {
        kinds: OUTAGE_KINDS.filter((kind) => kinds.includes(kind)),
        range: (RANGES as readonly string[]).includes(range ?? "")
            ? (range as Range)
            : DEFAULT_FILTERS.range,
        min: (MIN_LENGTHS as readonly string[]).includes(min ?? "")
            ? (min as MinLength)
            : DEFAULT_FILTERS.min,
        day: placed && dayLabel ? { label: dayLabel, ...placed } : null
    };
}

/** The words a CSV is written in, so it reads in the language it was exported in. */
export interface CsvWords {
    readonly headers: {
        readonly started: string;
        readonly ended: string;
        readonly durationSeconds: string;
        readonly kind: string;
        readonly detectedBy: string;
        readonly detail: string;
        readonly firstBack: string;
        readonly closedBy: string;
    };
    readonly kind: (kind: OutageKind) => string;
    readonly firstBack: (value: string) => string;
    readonly closedBy: (value: string | null) => string;
    readonly ongoing: string;
}

/**
 * The outages as a CSV: ISO timestamps (a spreadsheet parses them, and they say
 * the zone), whole seconds, and words for the codes. Cells are guarded against
 * formulas by `toCsv`, which matters here because a host name is somebody's input.
 */
export function outagesCsv(
    outages: readonly ListedOutage[],
    words: CsvWords,
    now: number,
    staleMs: number
): string {
    const header = [
        words.headers.started,
        words.headers.ended,
        words.headers.durationSeconds,
        words.headers.kind,
        words.headers.detectedBy,
        words.headers.detail,
        words.headers.firstBack,
        words.headers.closedBy
    ];
    const rows = outages.map((outage) => [
        outage.startedAt,
        outage.endedAt ?? words.ongoing,
        String(Math.round(outageLength(outage, now, staleMs) / 1000)),
        words.kind(outage.kind),
        outage.detectedBy ?? "",
        outage.detail ?? "",
        outage.firstBack === null ? "" : words.firstBack(outage.firstBack),
        outage.endedAt === null ? "" : words.closedBy(outage.closedBy)
    ]);
    return `${toCsv([header, ...rows])}\r\n`;
}

/** The export's file name: the view and the span it covers. */
export function csvFileName(outages: readonly ListedOutage[], filters: OutageFilters): string {
    if (filters.day) return `connectivity-outages-${filters.day.label}.csv`;
    const days = outages.map((outage) => outage.startedAt.slice(0, 10)).sort();
    const first = days[0];
    const last = days.at(-1);
    return first && last ? `connectivity-outages-${first}_${last}.csv` : "connectivity-outages.csv";
}
