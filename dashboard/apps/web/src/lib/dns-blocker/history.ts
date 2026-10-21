/**
 * The network filter's long-term statistics: each finished UTC day of the query log
 * folded into one bounded row before the DNS server deletes that day's file,
 * and those rows added back up over a range for the Overview.
 *
 * Pure and client-safe, so the roll-up and the sums are asserted without a
 * database or a container; the reads and writes are in `insights.ts`.
 */

import { z } from "zod";
import type { NameCount, QueryStats, QueryTimeline, QueryWindow } from "./query-log";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** How long a day's row is kept, as Pi-hole keeps its long-term data. */
export const DNS_HISTORY_DAYS = 365;

/** How far back one pass looks for finished days the log still holds: the
 *  longest log the settings allow, plus the day the engine keeps beyond it. */
export const DNS_HISTORY_BACKFILL_DAYS = 31;

/** How many names a merged top list shows. */
const HISTORY_TOP = 10;

/** The ranges the long-term card offers, in days. */
export const DNS_HISTORY_RANGES = { "30d": 30, "90d": 90, "365d": 365 } as const;
export type DnsHistoryRange = keyof typeof DNS_HISTORY_RANGES;
export const DNS_HISTORY_RANGE_IDS = Object.keys(DNS_HISTORY_RANGES) as DnsHistoryRange[];

export const dnsHistoryInputSchema = z.object({
    range: z.enum(DNS_HISTORY_RANGE_IDS as [DnsHistoryRange, ...DnsHistoryRange[]])
});

/** A top-list entry as stored: a device also carries the name it went by. */
const countSchema = z.object({
    name: z.string().max(512),
    count: z.number().int().min(0),
    label: z.string().max(256).optional()
});
const countsSchema = z.array(countSchema).max(100);

export type StoredCount = z.infer<typeof countSchema>;

/** One day's row, as written and as read back. */
export interface DnsDayRow {
    readonly day: Date;
    readonly queries: number;
    readonly blocked: number;
    readonly clients: number;
    readonly hourly: unknown;
    readonly topPermitted: unknown;
    readonly topBlocked: unknown;
    readonly topClients: unknown;
    readonly topBlockedClients: unknown;
    readonly blockedBy: unknown;
}

/** Start of the UTC day `at` falls in. */
export function utcDay(at: number): number {
    return Math.floor(at / DAY) * DAY;
}

/** The window that reads exactly one UTC day, an hour a bar. */
export function dayWindow(day: number): QueryWindow {
    return { from: day, to: day + DAY, bucketMs: HOUR, days: [new Date(day)] };
}

/** The finished days, newest first, a pass looks for: yesterday and back. */
export function finishedDays(now: number, back = DNS_HISTORY_BACKFILL_DAYS): number[] {
    const today = utcDay(now);
    return Array.from({ length: back }, (_, index) => today - (index + 1) * DAY);
}

/** One day's numbers, folded from a read of that day's file. */
export function dayRow(day: number, stats: QueryStats): DnsDayRow {
    const names = new Map(stats.clients.map((client) => [client.address, client.name]));
    const labelled = (items: readonly NameCount[]): StoredCount[] =>
        items.map((item) => {
            const label = names.get(item.name);
            return label ? { ...item, label } : { ...item };
        });
    return {
        day: new Date(day),
        queries: stats.queries,
        blocked: stats.blocked,
        clients: stats.clients.length,
        hourly: stats.timeline.allowed.map((allowed, hour) => [
            allowed,
            stats.timeline.blocked[hour] ?? 0
        ]),
        topPermitted: [...stats.topPermitted],
        topBlocked: [...stats.topBlocked],
        topClients: labelled(stats.topClients),
        topBlockedClients: labelled(stats.topBlockedClients),
        blockedBy: [...stats.blockedBy]
    };
}

/** A range of days added up, as the Overview's long-term card shows it. */
export interface DnsHistory {
    readonly days: number;
    readonly queries: number;
    readonly blocked: number;
    readonly blockedPercent: number;
    /** One bar a day from the range's first day to yesterday; a day with no
     *  row is zero. */
    readonly timeline: QueryTimeline;
    readonly topPermitted: readonly NameCount[];
    readonly topBlocked: readonly NameCount[];
    readonly topClients: readonly NameCount[];
    readonly topBlockedClients: readonly NameCount[];
    readonly blockedBy: readonly NameCount[];
    /** Names the devices in the top lists went by. */
    readonly clientNames: readonly { address: string; name: string }[];
}

/** A stored column read whole whatever was stored: a bad one counts as empty. */
function counts(value: unknown): StoredCount[] {
    const parsed = countsSchema.safeParse(value);
    return parsed.success ? parsed.data : [];
}

function merge(lists: readonly StoredCount[][]): NameCount[] {
    const total = new Map<string, number>();
    for (const list of lists)
        for (const item of list) total.set(item.name, (total.get(item.name) ?? 0) + item.count);
    return [...total]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, HISTORY_TOP)
        .map(([name, count]) => ({ name, count }));
}

/**
 * The days of a range added up. Top lists are each day's top names summed, so
 * a name that never made a day's top is not counted: what Pi-hole's long-term
 * view does with its own top lists, and what keeps a year to 365 small rows.
 */
export function historyFrom(
    rows: readonly DnsDayRow[],
    range: DnsHistoryRange,
    now: number
): DnsHistory {
    const days = DNS_HISTORY_RANGES[range];
    const last = utcDay(now) - DAY;
    const from = last - (days - 1) * DAY;
    const allowed = new Array<number>(days).fill(0);
    const blockedBars = new Array<number>(days).fill(0);
    let queries = 0;
    let blocked = 0;
    const kept = rows.filter((row) => {
        const at = utcDay(row.day.getTime());
        return at >= from && at <= last;
    });
    for (const row of kept) {
        const index = Math.round((utcDay(row.day.getTime()) - from) / DAY);
        queries += row.queries;
        blocked += row.blocked;
        allowed[index] = (allowed[index] ?? 0) + row.queries - row.blocked;
        blockedBars[index] = (blockedBars[index] ?? 0) + row.blocked;
    }
    const clients = kept.flatMap((row) => [
        ...counts(row.topClients),
        ...counts(row.topBlockedClients)
    ]);
    const clientNames = new Map<string, string>();
    for (const item of clients) if (item.label) clientNames.set(item.name, item.label);
    return {
        days,
        queries,
        blocked,
        blockedPercent: queries > 0 ? Math.round((blocked / queries) * 1000) / 10 : 0,
        timeline: { from, bucketMs: DAY, allowed, blocked: blockedBars },
        topPermitted: merge(kept.map((row) => counts(row.topPermitted))),
        topBlocked: merge(kept.map((row) => counts(row.topBlocked))),
        topClients: merge(kept.map((row) => counts(row.topClients))),
        topBlockedClients: merge(kept.map((row) => counts(row.topBlockedClients))),
        blockedBy: merge(kept.map((row) => counts(row.blockedBy))),
        clientNames: [...clientNames].map(([address, name]) => ({ address, name }))
    };
}
