/**
 * The DNS server's query log, read back: the days a range covers, parsed into
 * rows and folded into the numbers and series the screen shows.
 *
 * The engine writes one tab-separated line per lookup (Blocky's `csv` query
 * log): time, client address, client names, duration in ms, reason, name asked
 * for, answer, return code, response type, query type, instance. One file per
 * UTC day. Pure, so the parsing and the sums can be asserted without a
 * container; client-safe for the types and the schemas.
 */

import { z } from "zod";
import { normalizeDnsRule } from "./settings";

/** Where the engine writes its query log inside the container. */
export const QUERY_LOG_DIR = "/logs";

/** How many rows one page of the log holds. */
export const QUERY_LOG_ROWS = 100;
/** How far back the log pages: older lookups are still in the numbers. */
export const QUERY_LOG_PAGES = 50;

/** How many names a top list holds. */
export const TOP_COUNT = 10;
/** How many devices the activity chart draws, the busiest first. */
export const CLIENT_SERIES = 4;

/** Distinct names or devices one read keeps a count for. Past it, a new name
 *  is still in the totals but not in a top list - which only the busiest reach. */
const DISTINCT_MAX = 100_000;
/** Devices one read keeps a timeline for. */
const SERIES_CLIENTS_MAX = 512;

/** Bytes of the newest lookups the live view reads, under the 16 KiB the
 *  runtime returns from one command. */
export const TAIL_BYTES = 12_000;
/** Rows the live view shows. */
export const TAIL_ROWS = 50;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The ranges the screen offers, each with the width of one bar. */
export const DNS_RANGES = {
    "24h": { spanMs: DAY, bucketMs: 10 * MINUTE },
    "7d": { spanMs: 7 * DAY, bucketMs: HOUR },
    "30d": { spanMs: 30 * DAY, bucketMs: 6 * HOUR }
} as const;
export type DnsRange = keyof typeof DNS_RANGES;
export const DNS_RANGE_IDS = Object.keys(DNS_RANGES) as DnsRange[];

/** How many days of log a range needs kept. */
export function rangeDays(range: DnsRange): number {
    return DNS_RANGES[range].spanMs / DAY;
}

/** The file one UTC day's lookups are written to. */
export function queryLogPath(day: Date): string {
    return `${QUERY_LOG_DIR}/${day.toISOString().slice(0, 10)}_ALL.log`;
}

export interface QueryWindow {
    readonly from: number;
    readonly to: number;
    readonly bucketMs: number;
    /** Every UTC day the window touches, oldest first. */
    readonly days: readonly Date[];
}

/** The window a range covers at `now`, its end on the next bar's edge. Pure. */
export function rangeWindow(range: DnsRange, now: number): QueryWindow {
    const { spanMs, bucketMs } = DNS_RANGES[range];
    const to = Math.ceil((now + 1) / bucketMs) * bucketMs;
    const from = to - spanMs;
    const days: Date[] = [];
    for (let day = Math.floor(from / DAY) * DAY; day < to; day += DAY) days.push(new Date(day));
    return { from, to, bucketMs, days };
}

export type QueryOutcome = "blocked" | "allowed";

export interface QueryRow {
    /** As written, in the container's clock (UTC). */
    readonly time: string;
    /** The same, in milliseconds since the epoch; NaN when unreadable. */
    readonly at: number;
    readonly client: string;
    /** The device's name, when the engine learned one. */
    readonly clientName: string;
    readonly domain: string;
    readonly type: string;
    readonly outcome: QueryOutcome;
    readonly reason: string;
    readonly durationMs: number;
    /** Who answered: an upstream resolver's address, or `cache`, `local`,
     *  `blocked` or `other`. */
    readonly via: string;
    /** The category whose list blocked it, when one did. */
    readonly list: string;
}

export interface NameCount {
    readonly name: string;
    readonly count: number;
}

export interface QueryClient {
    readonly address: string;
    readonly name: string;
}

export interface QueryTimeline {
    readonly from: number;
    readonly bucketMs: number;
    readonly allowed: readonly number[];
    readonly blocked: readonly number[];
}

export interface ClientSeries {
    readonly client: string;
    readonly name: string;
    readonly counts: readonly number[];
}

export interface QueryStats {
    readonly queries: number;
    readonly blocked: number;
    /** Share of lookups blocked, 0-100, one decimal. */
    readonly blockedPercent: number;
    readonly timeline: QueryTimeline;
    readonly clientSeries: readonly ClientSeries[];
    readonly queryTypes: readonly NameCount[];
    readonly destinations: readonly NameCount[];
    readonly blockedBy: readonly NameCount[];
    readonly topPermitted: readonly NameCount[];
    readonly topBlocked: readonly NameCount[];
    readonly topClients: readonly NameCount[];
    readonly topBlockedClients: readonly NameCount[];
    readonly clients: readonly QueryClient[];
}

export interface QueryPage {
    readonly rows: readonly QueryRow[];
    readonly page: number;
    readonly hasMore: boolean;
}

export const queryFilterSchema = z.object({
    search: z.string().trim().toLowerCase().max(253).default(""),
    outcome: z.enum(["all", "blocked", "allowed"]).default("all"),
    client: z.string().trim().max(64).default(""),
    type: z
        .string()
        .trim()
        .toUpperCase()
        .regex(/^[A-Z0-9]{0,10}$/)
        .default(""),
    range: z.enum(DNS_RANGE_IDS as [DnsRange, ...DnsRange[]]).default("24h"),
    page: z
        .number()
        .int()
        .min(0)
        .max(QUERY_LOG_PAGES - 1)
        .default(0)
});

export type QueryFilter = z.infer<typeof queryFilterSchema>;

/** Who answered a lookup, from its response type and reason. */
function viaOf(responseType: string, reason: string): string {
    if (responseType === "BLOCKED" || responseType === "REBIND") return "blocked";
    if (responseType === "CACHED") return "cache";
    if (["CUSTOMDNS", "HOSTSFILE", "SPECIAL", "NOTFQDN"].includes(responseType)) return "local";
    const upstream = /^(?:RESOLVED|CONDITIONAL) \((.+)\)$/.exec(reason)?.[1];
    return upstream ?? "other";
}

/** Blocky's time cell, `2026-10-18 10:00:00`, read as UTC. */
function timeOf(time: string): number {
    return Date.parse(`${time.trim().replace(" ", "T")}Z`);
}

/** One line of the log, or null for a line that is not one. */
export function parseQueryLine(line: string): QueryRow | null {
    const cells = line.split("\t");
    if (cells.length < 10) return null;
    const [time, client, names, duration, reason, question, , , responseType, type] = cells;
    if (!time || !client || !question) return null;
    const name = (names ?? "").split(";")[0]?.trim().replace(/\.$/, "") ?? "";
    const response = responseType ?? "";
    const why = reason ?? "";
    return {
        time,
        at: timeOf(time),
        client,
        clientName: name && name !== client ? name : "",
        domain: question.replace(/\.$/, "").toLowerCase(),
        type: type ?? "",
        // REBIND is the engine refusing a public name that answers with a
        // private address: a block too, for the reader.
        outcome: response === "BLOCKED" || response === "REBIND" ? "blocked" : "allowed",
        reason: why,
        durationMs: Number.parseInt(duration ?? "", 10) || 0,
        via: viaOf(response, why),
        list: /^BLOCKED \((.+)\)$/.exec(why)?.[1] ?? ""
    };
}

/** Whether a row is one the log is filtered to (the range is the window's). */
export function rowMatches(row: QueryRow, filter: Omit<QueryFilter, "range" | "page">): boolean {
    if (filter.outcome !== "all" && row.outcome !== filter.outcome) return false;
    if (filter.client && row.client !== filter.client) return false;
    if (filter.type && row.type !== filter.type) return false;
    return !filter.search || row.domain.includes(filter.search);
}

function ranked(counts: Map<string, number>, limit = TOP_COUNT): NameCount[] {
    return [...counts]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, limit)
        .map(([name, count]) => ({ name, count }));
}

function bump(counts: Map<string, number>, key: string): void {
    const held = counts.get(key);
    if (held !== undefined) counts.set(key, held + 1);
    else if (counts.size < DISTINCT_MAX) counts.set(key, 1);
}

/**
 * Folds lines in as they arrive, so no day's file is ever held whole. Every
 * lookup inside the window counts toward the numbers; only the rows that match
 * the filter are kept, and only as many as the last page needs, so one read
 * answers every page.
 */
export class QueryLogReader {
    private queries = 0;
    private blocked = 0;
    private readonly buckets: number;
    private readonly allowedBars: number[];
    private readonly blockedBars: number[];
    private readonly perClient = new Map<string, number[]>();
    private readonly types = new Map<string, number>();
    private readonly destinations = new Map<string, number>();
    private readonly lists = new Map<string, number>();
    private readonly permitted = new Map<string, number>();
    private readonly blockedDomains = new Map<string, number>();
    private readonly clients = new Map<string, number>();
    private readonly blockedClients = new Map<string, number>();
    private readonly names = new Map<string, string>();
    private readonly rows: QueryRow[] = [];
    // One row past the last page says whether there is an older one.
    private readonly keep = QUERY_LOG_PAGES * QUERY_LOG_ROWS + 1;

    public constructor(
        private readonly filter: Omit<QueryFilter, "page">,
        private readonly window: QueryWindow
    ) {
        this.buckets = Math.round((window.to - window.from) / window.bucketMs);
        this.allowedBars = new Array<number>(this.buckets).fill(0);
        this.blockedBars = new Array<number>(this.buckets).fill(0);
    }

    public add(line: string): void {
        const row = parseQueryLine(line);
        if (!row || !(row.at >= this.window.from && row.at < this.window.to)) return;
        const bar = Math.floor((row.at - this.window.from) / this.window.bucketMs);
        this.queries += 1;
        bump(this.types, row.type || "?");
        bump(this.destinations, row.via);
        bump(this.clients, row.client);
        if (row.clientName && this.names.size < DISTINCT_MAX)
            this.names.set(row.client, row.clientName);
        let series = this.perClient.get(row.client);
        if (!series && this.perClient.size < SERIES_CLIENTS_MAX) {
            series = new Array<number>(this.buckets).fill(0);
            this.perClient.set(row.client, series);
        }
        if (series) series[bar] = (series[bar] ?? 0) + 1;
        if (row.outcome === "blocked") {
            this.blocked += 1;
            this.blockedBars[bar] = (this.blockedBars[bar] ?? 0) + 1;
            bump(this.blockedDomains, row.domain);
            bump(this.blockedClients, row.client);
            if (row.list) bump(this.lists, row.list);
        } else {
            this.allowedBars[bar] = (this.allowedBars[bar] ?? 0) + 1;
            bump(this.permitted, row.domain);
        }
        if (!rowMatches(row, this.filter)) return;
        this.rows.push(row);
        // The files are oldest first: keep only the newest rows the page needs.
        if (this.rows.length > this.keep * 2) this.rows.splice(0, this.rows.length - this.keep);
    }

    public stats(): QueryStats {
        const label = (client: string) => this.names.get(client) ?? "";
        return {
            queries: this.queries,
            blocked: this.blocked,
            blockedPercent:
                this.queries > 0 ? Math.round((this.blocked / this.queries) * 1000) / 10 : 0,
            timeline: {
                from: this.window.from,
                bucketMs: this.window.bucketMs,
                allowed: this.allowedBars,
                blocked: this.blockedBars
            },
            clientSeries: ranked(this.clients, CLIENT_SERIES)
                .filter((item) => this.perClient.has(item.name))
                .map((item) => ({
                    client: item.name,
                    name: label(item.name),
                    counts: this.perClient.get(item.name) ?? []
                })),
            queryTypes: ranked(this.types, 12),
            destinations: ranked(this.destinations, 12),
            blockedBy: ranked(this.lists, 12),
            topPermitted: ranked(this.permitted),
            topBlocked: ranked(this.blockedDomains),
            topClients: ranked(this.clients),
            topBlockedClients: ranked(this.blockedClients),
            clients: [...this.clients.keys()]
                .sort()
                .slice(0, 500)
                .map((address) => ({ address, name: label(address) }))
        };
    }

    /** One page of matching rows, newest first. */
    public page(page: number): QueryPage {
        const newest = this.rows.slice(-this.keep).reverse();
        const start = page * QUERY_LOG_ROWS;
        return {
            rows: newest.slice(start, start + QUERY_LOG_ROWS),
            page,
            hasMore: newest.length > start + QUERY_LOG_ROWS
        };
    }
}

/**
 * The live view: the newest lookups in the last `TAIL_BYTES` of today's file,
 * newest first. The read starts mid-line unless it holds the whole file, so
 * the first line is dropped then.
 */
export function parseTail(
    text: string,
    whole: boolean,
    filter: Omit<QueryFilter, "range" | "page">
): QueryRow[] {
    const lines = text.split("\n");
    if (!whole) lines.shift();
    const rows: QueryRow[] = [];
    for (let at = lines.length - 1; at >= 0 && rows.length < TAIL_ROWS; at -= 1) {
        const row = parseQueryLine(lines[at] ?? "");
        if (row && rowMatches(row, filter)) rows.push(row);
    }
    return rows;
}

/** What the engine's metrics say about its lists. */
export interface EngineMetrics {
    /** Names on each category's lists, as loaded. */
    readonly lists: readonly NameCount[];
    /** Every name on a list, summed. */
    readonly listed: number;
    /** When the lists were last loaded, ms since the epoch. */
    readonly lastRefresh: number | null;
    readonly failedDownloads: number;
}

const METRIC = /^([a-z_]+)(?:\{([^}]*)\})?\s+(\S+)/;

/** The Prometheus text the engine answers `/metrics` with, read for its lists. Pure. */
export function parseEngineMetrics(text: string): EngineMetrics {
    const lists: NameCount[] = [];
    let lastRefresh: number | null = null;
    let failedDownloads = 0;
    for (const line of text.split("\n")) {
        const match = METRIC.exec(line.trim());
        if (!match) continue;
        const [, name, labels = "", raw = ""] = match;
        const value = Number(raw);
        if (!Number.isFinite(value)) continue;
        if (name === "blocky_denylist_cache_entries") {
            const group = /group="([^"]*)"/.exec(labels)?.[1];
            if (group) lists.push({ name: group, count: value });
        } else if (name === "blocky_last_list_group_refresh_timestamp_seconds" && value > 0) {
            lastRefresh = value * 1000;
        } else if (name === "blocky_failed_downloads_total") {
            failedDownloads = value;
        }
    }
    lists.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    return {
        lists,
        listed: lists.reduce((sum, item) => sum + item.count, 0),
        lastRefresh,
        failedDownloads
    };
}

/** Blocky's `blocking status` sentence, read into a state. */
export function parseBlockingStatus(output: string): {
    enabled: boolean;
    secondsLeft: number | null;
} {
    if (/blocking enabled/i.test(output)) return { enabled: true, secondsLeft: null };
    const seconds = /for (\d+) seconds/i.exec(output)?.[1];
    return { enabled: false, secondsLeft: seconds ? Number.parseInt(seconds, 10) : null };
}

/** How long a pause may be asked for, in seconds; 0 is until it is resumed. */
export const pauseSchema = z.object({
    seconds: z
        .number()
        .int()
        .min(0)
        .max(24 * 60 * 60)
});

/** A name from the log put on the allow or the block list. */
export const ruleFromLogSchema = z.object({
    domain: z.string().transform((value, ctx) => {
        const rule = normalizeDnsRule(value);
        if (!rule || rule.startsWith("/")) {
            ctx.addIssue({ code: "custom", message: "invalidRule" }); // i18n-ignore a key the screen says
            return z.NEVER;
        }
        return rule;
    }),
    list: z.enum(["allow", "deny"])
});
