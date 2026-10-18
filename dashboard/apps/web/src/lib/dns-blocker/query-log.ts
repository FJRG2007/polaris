/**
 * The DNS server's query log, read back: one day's file, parsed into rows and
 * summed into the numbers the screen shows.
 *
 * The engine writes one tab-separated line per lookup (Blocky's `csv` query
 * log): time, client address, client names, duration in ms, reason, name asked
 * for, answer, return code, response type, query type, instance. Pure, so the
 * parsing and the sums can be asserted without a container.
 */

import { z } from "zod";

/** Where the engine writes its query log inside the container. */
export const QUERY_LOG_DIR = "/logs";

/** How many matching rows the screen is sent, newest first. */
export const QUERY_LOG_ROWS = 200;

/** How many names a top list holds. */
export const TOP_COUNT = 10;

/** The file one UTC day's lookups are written to. */
export function queryLogPath(day: Date): string {
    return `${QUERY_LOG_DIR}/${day.toISOString().slice(0, 10)}_ALL.log`;
}

export type QueryOutcome = "blocked" | "allowed";

export interface QueryRow {
    /** As written, in the container's clock (UTC). */
    readonly time: string;
    readonly client: string;
    readonly domain: string;
    readonly type: string;
    readonly outcome: QueryOutcome;
    readonly reason: string;
    readonly durationMs: number;
}

export interface NameCount {
    readonly name: string;
    readonly count: number;
}

export interface QueryStats {
    readonly queries: number;
    readonly blocked: number;
    /** Share of lookups blocked, 0-100, one decimal. */
    readonly blockedPercent: number;
    readonly topDomains: readonly NameCount[];
    readonly topBlocked: readonly NameCount[];
    readonly topClients: readonly NameCount[];
    readonly clients: readonly string[];
}

export const queryFilterSchema = z.object({
    search: z.string().trim().toLowerCase().max(253).default(""),
    outcome: z.enum(["all", "blocked", "allowed"]).default("all"),
    client: z.string().trim().max(64).default("")
});

export type QueryFilter = z.infer<typeof queryFilterSchema>;

/** One line of the log, or null for a line that is not one. */
export function parseQueryLine(line: string): QueryRow | null {
    const cells = line.split("\t");
    if (cells.length < 10) return null;
    const [time, client, , duration, reason, question, , , responseType, type] = cells;
    if (!time || !client || !question) return null;
    return {
        time,
        client,
        domain: question.replace(/\.$/, "").toLowerCase(),
        type: type ?? "",
        // REBIND is the engine refusing a public name that answers with a
        // private address: a block too, for the reader.
        outcome: responseType === "BLOCKED" || responseType === "REBIND" ? "blocked" : "allowed",
        reason: reason ?? "",
        durationMs: Number.parseInt(duration ?? "", 10) || 0
    };
}

function matches(row: QueryRow, filter: QueryFilter): boolean {
    if (filter.outcome !== "all" && row.outcome !== filter.outcome) return false;
    if (filter.client && row.client !== filter.client) return false;
    return !filter.search || row.domain.includes(filter.search);
}

function top(counts: Map<string, number>): NameCount[] {
    return [...counts]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, TOP_COUNT)
        .map(([name, count]) => ({ name, count }));
}

function bump(counts: Map<string, number>, key: string): void {
    counts.set(key, (counts.get(key) ?? 0) + 1);
}

/** Folds lines in as they arrive, so a day's file never has to be held whole. */
export class QueryLogReader {
    private queries = 0;
    private blocked = 0;
    private readonly domains = new Map<string, number>();
    private readonly blockedDomains = new Map<string, number>();
    private readonly clients = new Map<string, number>();
    private readonly rows: QueryRow[] = [];

    public constructor(private readonly filter: QueryFilter) {}

    public add(line: string): void {
        const row = parseQueryLine(line);
        if (!row) return;
        this.queries += 1;
        bump(this.domains, row.domain);
        bump(this.clients, row.client);
        if (row.outcome === "blocked") {
            this.blocked += 1;
            bump(this.blockedDomains, row.domain);
        }
        if (!matches(row, this.filter)) return;
        this.rows.push(row);
        // Keep only the newest page; the file is oldest first.
        if (this.rows.length > QUERY_LOG_ROWS * 2) this.rows.splice(0, QUERY_LOG_ROWS);
    }

    public stats(): QueryStats {
        return {
            queries: this.queries,
            blocked: this.blocked,
            blockedPercent:
                this.queries > 0 ? Math.round((this.blocked / this.queries) * 1000) / 10 : 0,
            topDomains: top(this.domains),
            topBlocked: top(this.blockedDomains),
            topClients: top(this.clients),
            clients: [...this.clients.keys()].sort()
        };
    }

    /** The matching rows, newest first. */
    public newest(): QueryRow[] {
        return this.rows.slice(-QUERY_LOG_ROWS).reverse();
    }
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

/** How long a pause may be asked for, in minutes. */
export const pauseSchema = z.object({
    minutes: z
        .number()
        .int()
        .min(1)
        .max(24 * 60)
});
