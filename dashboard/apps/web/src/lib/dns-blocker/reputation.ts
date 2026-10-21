/**
 * Blocking domains by what a reputation service says about them, rather than by
 * a list somebody published.
 *
 * Each domain is asked about once, after a device on the network asked for it:
 * the DNS server cannot wait for a paid lookup before it answers, so the first
 * visit to a domain nobody has asked for before goes through, and the domain is
 * blocked from the next pass on (a few minutes). What the service said is kept
 * per domain - a day for a clean one, a week for a flagged one - so a domain is
 * one lookup a day at most whoever asks for it.
 *
 * The flagged domains reach the DNS server as one file per category on its own
 * volume, which the rendered configuration names as a list, the way NextDNS and
 * AdGuard Home add their threat feeds next to the lists you picked. Everything
 * here is pure; the lookups and the file are `reputation-service.ts`'s.
 */

import { z } from "zod";
import { QUERY_LOG_DIR, parseQueryLine } from "./query-log";
import { DNS_REPUTATION_CATEGORIES, type DnsReputationCategory } from "./settings";

/** How long a domain the service found nothing against is believed. */
export const CLEAN_TTL_MS = 24 * 60 * 60 * 1000;
/** How long a flagged domain stays flagged before it is asked about again. */
export const FLAGGED_TTL_MS = 7 * CLEAN_TTL_MS;

/** Domains looked up in one pass at most, whatever the budget would allow. */
export const LOOKUPS_PER_PASS = 20;
/** Flagged domains written to the DNS server's file at most, newest first. */
export const PUBLISHED_MAX = 50_000;

/** The list group a category's flagged domains are loaded as; it is what the
 *  query log names when one of them is blocked. */
export function reputationList(category: DnsReputationCategory): string {
    return `dymo-${category}`;
}

/** The category a list group is, or null when it is not a reputation list. */
export function reputationCategoryOf(list: string): DnsReputationCategory | null {
    const category = list.startsWith("dymo-") ? list.slice("dymo-".length) : "";
    return (DNS_REPUTATION_CATEGORIES as readonly string[]).includes(category)
        ? (category as DnsReputationCategory)
        : null;
}

/** Where a category's file lives inside the DNS server's container. */
export function reputationListPath(category: DnsReputationCategory): string {
    return `${QUERY_LOG_DIR}/reputation-${category}.txt`;
}

/** When a verdict should be asked for again. */
export function verdictExpiry(flagged: boolean, now: number): Date {
    return new Date(now + (flagged ? FLAGGED_TTL_MS : CLEAN_TTL_MS));
}

/** Endings that only ever name something on this network, never a site. */
const LOCAL_ENDINGS = /\.(?:local|lan|home|internal|arpa|localdomain|home\.arpa|test|invalid)$/;
const IP_LIKE = /^[\d.]+$|:/;

/**
 * Whether a looked-up name is one worth asking about: a public name with a dot,
 * that is not an address, nor this network's own.
 */
export function worthChecking(domain: string): boolean {
    if (!domain.includes(".") || domain.length > 253) return false;
    if (IP_LIKE.test(domain) || LOCAL_ENDINGS.test(domain)) return false;
    return /^[a-z0-9.-]+$/.test(domain);
}

/** One verdict as it is kept. */
export interface DomainVerdict {
    readonly domain: string;
    readonly fraud: boolean;
    readonly adult: boolean;
}

/**
 * Each category's file: the flagged domains in it, sorted, one per line. A
 * category with nothing flagged is still a file, so the list the configuration
 * names always loads.
 */
export function reputationFiles(
    verdicts: readonly DomainVerdict[],
    categories: readonly DnsReputationCategory[]
): Map<DnsReputationCategory, string> {
    const files = new Map<DnsReputationCategory, string>();
    for (const category of categories) {
        const names = [
            ...new Set(verdicts.filter((verdict) => verdict[category]).map((v) => v.domain))
        ].sort();
        // A comment line keeps an empty list a list rather than a missing file.
        files.set(category, `${["# Polaris: domains Dymo flagged", ...names].join("\n")}\n`);
    }
    return files;
}

/** What the screen sends to unblock or check one flagged domain again. */
export const reputationDomainSchema = z.object({
    domain: z
        .string()
        .trim()
        .toLowerCase()
        .max(253)
        .refine((value) => worthChecking(value), "invalidDomain")
});

/** Why reputation lookups are not running, or null when they are. */
export type ReputationOff = "integrationOff" | "noKey" | "noCategory";

/** Where the reputation pass stopped reading the query log: a day's file, and
 *  the byte after the last line it finished with. */
export const logCursorSchema = z.object({
    file: z.string().min(1).max(256),
    offset: z.number().int().min(0)
});
export type LogCursor = z.infer<typeof logCursorSchema>;

/** Bytes of log one pass reads at most; the next pass goes on from there. */
export const READ_BYTES_PER_PASS = 4 * 1024 * 1024;

/**
 * The files to read this pass, in order. When the day turned, the rest of the
 * day the cursor is in comes first, then the new day from its start.
 */
export function readPlan(cursor: LogCursor | null, today: string): LogCursor[] {
    if (!cursor) return [{ file: today, offset: 0 }];
    if (cursor.file === today) return [cursor];
    return [cursor, { file: today, offset: 0 }];
}

/** One name worth asking about, and the bytes of the line it was on. */
export interface LogEntry {
    readonly domain: string;
    readonly start: number;
    readonly end: number;
}

/** What one read of a file found. */
export interface LogSliceRead {
    /** Each name once, in the order first seen. */
    readonly entries: readonly LogEntry[];
    /** The byte after the last whole line read. */
    readonly end: number;
    /** The file is shorter than the cursor: it was cut or replaced. */
    readonly truncated: boolean;
    /** The whole rest of the file was read, rather than stopping at the limit. */
    readonly complete: boolean;
}

/**
 * Reads one log file from a byte offset, fed the file's chunks in order, and
 * stops after `maxBytes` of whole lines. Pure; the stream is the caller's.
 * Offsets are bytes, so a name with non-ASCII characters cannot shift them.
 */
export class LogSlice {
    private seen = 0;
    private rest: Buffer = Buffer.alloc(0);
    private restStart: number;
    private done = false;
    private readonly entries: LogEntry[] = [];
    private readonly names = new Set<string>();

    constructor(
        private readonly offset: number,
        private readonly maxBytes: number = READ_BYTES_PER_PASS
    ) {
        this.restStart = offset;
    }

    /** Feed the next chunk; false once enough has been read. */
    add(chunk: Uint8Array): boolean {
        if (this.done) return false;
        const from = this.seen;
        this.seen += chunk.length;
        if (this.seen <= this.offset) return true;
        const part = Buffer.from(chunk).subarray(Math.max(0, this.offset - from));
        this.rest = this.rest.length ? Buffer.concat([this.rest, part]) : part;
        let at = 0;
        for (;;) {
            const newline = this.rest.indexOf(0x0a, at);
            if (newline < 0) break;
            const start = this.restStart + at;
            const end = this.restStart + newline + 1;
            this.line(this.rest.subarray(at, newline).toString("utf8"), start, end);
            at = newline + 1;
            if (end - this.offset >= this.maxBytes) {
                this.done = true;
                break;
            }
        }
        this.rest = this.rest.subarray(at);
        this.restStart += at;
        return !this.done;
    }

    private line(text: string, start: number, end: number): void {
        const row = parseQueryLine(text);
        if (!row || row.outcome !== "allowed" || row.via === "local") return;
        if (!worthChecking(row.domain) || this.names.has(row.domain)) return;
        this.names.add(row.domain);
        this.entries.push({ domain: row.domain, start, end });
    }

    finish(): LogSliceRead {
        return {
            entries: this.entries,
            end: this.restStart,
            truncated: this.seen < this.offset,
            complete: !this.done
        };
    }
}

/**
 * Where the cursor goes after a pass handled some of a slice's names: the start
 * of the first line whose name is still unasked (the budget ran out there), or
 * the end of what was read when every name was dealt with.
 */
export function cursorAfter(
    entries: readonly LogEntry[],
    handled: ReadonlySet<string>,
    end: number
): number {
    const first = entries.find((entry) => !handled.has(entry.domain));
    return first ? first.start : end;
}
