/**
 * What the DNS server has been doing: today's lookups, the numbers over them,
 * and pausing blocking for a while.
 *
 * Everything is asked of the engine's own container on this machine. The log
 * is a file the engine writes (read through the runtime's file stream), and the
 * pause goes through the engine's own command line, which talks to its API on
 * the container's loopback - so that API, which has no password, is never
 * published to the network.
 */

import { prisma, type Prisma } from "@polaris/db";
import type { RuntimePorts } from "@polaris/deploy";
import { DnsBlockerRefusal, engineConfigCurrent, engineRow, readSettings } from "./service";
import {
    DNS_HISTORY_BACKFILL_DAYS,
    DNS_HISTORY_DAYS,
    DNS_HISTORY_RANGES,
    dayRow,
    dayWindow,
    finishedDays,
    historyFrom,
    utcDay,
    type DnsHistory,
    type DnsHistoryRange
} from "./history";
import { getPorts, type TargetRow } from "@/lib/deploy/runtime";
import { resolveContainerName } from "@/lib/container-files-service";
import {
    QueryLogReader,
    TAIL_BYTES,
    parseBlockingStatus,
    parseLookup,
    parseEngineMetrics,
    parseTail,
    queryFilterSchema,
    queryLogPath,
    rangeWindow,
    type DnsLookup,
    type DnsRange,
    type EngineMetrics,
    type QueryFilter,
    type QueryPage,
    type QueryRow,
    type QueryStats,
    type SeenDevice
} from "./query-log";
import { DNS_ENGINE_HTTP_PORT } from "./render";
import { QueryLogFollower, type LogSource } from "./log-follow";

const BLOCKY = "/app/blocky";

/** How long one read of the log answers the same filter again, on any page: a
 *  range that reaches into past days costs a file per day, and moves by the bar
 *  anyway. */
const LOG_TTL_MS = { "24h": 10_000, "7d": 60_000, "30d": 120_000 } as const;
/** How many filters' reads are kept at once. */
const LOG_CACHE_MAX = 32;

export interface DnsInsights {
    readonly stats: QueryStats;
    readonly log: QueryPage;
    readonly pause: { readonly enabled: boolean; readonly secondsLeft: number | null };
    /** The engine runs a configuration from before the query log existed, so
     *  nothing is recorded until it is applied again. */
    readonly logOff: boolean;
}

interface Engine {
    readonly row: NonNullable<Awaited<ReturnType<typeof engineRow>>>;
    readonly ports: RuntimePorts;
    readonly container: string;
}

interface LogRead {
    readonly found: boolean;
    readonly stats: QueryStats;
    readonly reader: QueryLogReader;
}

const logReads = new Map<string, { readonly at: number; readonly read: Promise<LogRead> }>();

/** Bytes of a file one command carries, as base64 under the 16 KiB a command
 *  returns. */
const APPEND_CHUNK = 11_000;
/** Past this much new text a file is streamed instead, from where it was left:
 *  the first read of a day, or one after a long quiet spell. */
const STREAM_PAST = 8 * APPEND_CHUNK;

/** The unfiltered 24 hours, followed per DNS server container (see `log-follow`). */
const followers = new Map<
    string,
    { readonly follower: QueryLogFollower; readonly current: { target: Engine } }
>();

/** The DNS server's container and the runtime that reaches it, for the other
 *  modules that ask it something. */
export function engineTarget(): Promise<Engine> {
    return engine();
}

async function engine(): Promise<Engine> {
    const row = await engineRow();
    if (!row?.applicationId) throw new DnsBlockerRefusal("notRunning");
    const app = await prisma.application.findUnique({
        where: { id: row.applicationId },
        select: { target: true }
    });
    if (!app) throw new DnsBlockerRefusal("notRunning");
    const [ports, container] = await Promise.all([
        getPorts(app.target as TargetRow, row.ownerId),
        resolveContainerName(row.applicationId)
    ]);
    return { row, ports, container };
}

/** Whether today's file was there to read. */
async function readLog(target: Engine, path: string, reader: QueryLogReader): Promise<boolean> {
    let stream: ReadableStream<Uint8Array>;
    try {
        stream = await target.ports.readFile(target.container, path);
    } catch {
        // No file yet: nothing has been asked today.
        return false;
    }
    const decoder = new TextDecoder();
    let rest = "";
    for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
        const lines = (rest + decoder.decode(chunk, { stream: true })).split("\n");
        rest = lines.pop() ?? "";
        for (const line of lines) reader.add(line);
    }
    reader.add(rest + decoder.decode());
    return true;
}

/** Every day the window touches, one after the other into one reader, so
 *  only one file is ever being read at a time. */
async function readDays(target: Engine, days: readonly Date[], reader: QueryLogReader) {
    let found = false;
    for (const day of days) if (await readLog(target, queryLogPath(day), reader)) found = true;
    return found;
}

/** A file's bytes from `from` on, through the runtime's file stream: no limit
 *  on its length, but it starts at the file's beginning. */
async function* streamFrom(target: Engine, path: string, from: number): AsyncIterable<Uint8Array> {
    const stream = await target.ports.readFile(target.container, path);
    let skip = from;
    for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
        if (skip >= chunk.length) {
            skip -= chunk.length;
            continue;
        }
        yield skip > 0 ? chunk.subarray(skip) : chunk;
        skip = 0;
    }
}

/** A piece of a file from `from`, as base64, with the file's size first when
 *  `$4` is set: under `STREAM_PAST` new bytes the piece is read here, past it
 *  only the size is said. The path and the numbers are arguments, never part
 *  of the script. */
const PIECE_SCRIPT = [
    'if [ -n "$4" ]; then size=$(stat -c %s "$1") || exit 1; echo "$size";',
    '[ "$size" -gt "$2" ] && [ $((size - $2)) -le "$4" ] || exit 0; fi;',
    'tail -c +$(($2 + 1)) "$1" | head -c "$3" | base64'
].join(" ");

/** The DNS server's log files as the follower reads them: what was written
 *  since the last ask, a command's worth at a time, or the file streamed when
 *  more than a few of those are waiting. */
function engineSource(current: () => Engine): LogSource {
    const piece = (path: string, from: number, sized: boolean) =>
        current().ports.runIn(current().container, [
            "sh",
            "-c",
            PIECE_SCRIPT,
            "sh",
            path,
            String(from),
            String(APPEND_CHUNK),
            sized ? String(STREAM_PAST) : ""
        ]);
    async function* pieces(path: string, from: number, size: number, first: string | null) {
        let at = from;
        let encoded = first;
        while (at < size) {
            if (encoded === null) {
                yield* streamFrom(current(), path, at);
                return;
            }
            const bytes = Buffer.from(encoded, "base64");
            if (bytes.length === 0) return;
            yield bytes;
            at += bytes.length;
            if (at >= size) return;
            const next = await piece(path, at, false);
            // A command that could not read it: the stream can.
            encoded = next.code === 0 ? next.output : null;
        }
    }
    return {
        async open(path, from) {
            const result = await piece(path, from, true);
            const newline = result.output.indexOf("\n");
            const head = result.output.slice(0, newline < 0 ? undefined : newline).trim();
            // No size: no such file (or no way to tell, which reads the same).
            if (!/^\d+$/.test(head)) return null;
            const size = Number(head);
            const rest = newline < 0 ? "" : result.output.slice(newline + 1);
            const streamed = result.code !== 0 || size - from > STREAM_PAST;
            return { size, pieces: pieces(path, from, size, streamed ? null : rest) };
        }
    };
}

/** The unfiltered last 24 hours, followed rather than read again whole. */
function followedLog(target: Engine, now: number): Promise<LogRead> {
    let followed = followers.get(target.container);
    if (!followed) {
        // One DNS server at a time: a container left behind by a reinstall is
        // not followed any further.
        followers.clear();
        const current = { target };
        followed = { current, follower: new QueryLogFollower(engineSource(() => current.target)) };
        followers.set(target.container, followed);
    }
    followed.current.target = target;
    return followed.follower
        .read(rangeWindow("24h", now))
        .then(({ found, reader }) => ({ found, stats: reader.stats(), reader }));
}

/** Whether a filter is the unfiltered last 24 hours: the Overview, the summary
 *  card and the devices seen, which the follower answers. */
function isFollowed(filter: Omit<QueryFilter, "page">): boolean {
    const { search, outcome, client, type, range } = filter;
    return range === "24h" && !search && outcome === "all" && !client && !type;
}

/**
 * Start following the last 24 hours, so the first visit after an update finds
 * it read. Quiet when there is no DNS server to read, and never in anybody's
 * way: run by the `dns-blocker-log` job.
 */
export async function followQueryLog(): Promise<void> {
    let target: Engine;
    try {
        target = await engine();
    } catch (error) {
        if (error instanceof DnsBlockerRefusal) return;
        throw error;
    }
    await cachedLog(target, rowsOf(queryFilterSchema.parse({})), true);
}

function rowsOf(filter: QueryFilter): Omit<QueryFilter, "page"> {
    const { page: _page, ...rows } = filter;
    return rows;
}

/** One read of the log per filter for a few seconds, shared by whoever asks
 *  meanwhile and by every page, so refreshes, paging and several admins do not
 *  each copy the files. */
function cachedLog(
    target: Engine,
    filter: Omit<QueryFilter, "page">,
    fresh: boolean
): Promise<LogRead> {
    const now = Date.now();
    const window = rangeWindow(filter.range, now);
    const ttl = LOG_TTL_MS[filter.range];
    const { search, outcome, client, type, range } = filter;
    const key = JSON.stringify([target.container, search, outcome, client, type, range]);
    const hit = logReads.get(key);
    if (hit && !fresh && now - hit.at < ttl) return hit.read;
    const read = isFollowed(filter)
        ? followedLog(target, now)
        : (() => {
              const reader = new QueryLogReader(filter, window);
              return readDays(target, window.days, reader).then((found) => ({
                  found,
                  stats: reader.stats(),
                  reader
              }));
          })();
    const entry = { at: now, read };
    read.catch(() => {
        if (logReads.get(key) === entry) logReads.delete(key);
    });
    for (const [other, { at }] of logReads)
        if (now - at >= LOG_TTL_MS["30d"]) logReads.delete(other);
    logReads.delete(key);
    logReads.set(key, entry);
    while (logReads.size > LOG_CACHE_MAX) logReads.delete(logReads.keys().next().value as string);
    return read;
}

async function blocky(target: Engine, args: readonly string[]): Promise<string> {
    const result = await target.ports.runIn(target.container, [BLOCKY, ...args]);
    if (result.code !== 0) {
        console.error("polaris: network filter command failed:", result.output);
        throw new DnsBlockerRefusal("notAnswering");
    }
    return result.output;
}

/** The range's numbers, one page of the lookups that match, and whether
 *  blocking is paused. */
export async function dnsInsights(filter: QueryFilter, fresh = false): Promise<DnsInsights> {
    const target = await engine();
    const { page, ...rows } = filter;
    const [log, status] = await Promise.all([
        cachedLog(target, rows, fresh),
        blocky(target, ["blocking", "status"])
    ]);
    const logOff = !log.found && !(await engineConfigCurrent(target.row));
    return {
        stats: log.stats,
        log: log.reader.page(page),
        pause: parseBlockingStatus(status),
        logOff
    };
}

/** Every device the log saw over a range, through the same unfiltered read as
 *  the Overview, and whether the log is off. */
export async function seenDevices(
    range: DnsRange,
    fresh = false
): Promise<{ devices: SeenDevice[]; logOff: boolean }> {
    const target = await engine();
    const { page: _page, ...rows } = queryFilterSchema.parse({ range });
    const log = await cachedLog(target, rows, fresh);
    const logOff = !log.found && !(await engineConfigCurrent(target.row));
    return { devices: log.reader.devices(), logOff };
}

/** The newest lookups that match, for the live view: the end of today's file
 *  only, so asking every few seconds costs a few kilobytes. */
export async function tailQueries(filter: QueryFilter): Promise<QueryRow[]> {
    const target = await engine();
    const result = await target.ports.runIn(target.container, [
        "tail",
        "-c",
        String(TAIL_BYTES),
        queryLogPath(new Date())
    ]);
    // No file yet: nothing asked today.
    if (result.code !== 0) return [];
    return parseTail(result.output, Buffer.byteLength(result.output) < TAIL_BYTES, filter);
}

/**
 * What the engine's own metrics say about its lists, or null when the engine
 * runs a configuration from before they were switched on. Asked on the
 * container's loopback, and cut to the lines read here so the answer stays
 * under what one command returns.
 */
export async function engineMetrics(): Promise<EngineMetrics | null> {
    const target = await engine();
    const result = await target.ports.runIn(target.container, [
        "sh",
        "-c",
        `wget -qO- http://127.0.0.1:${DNS_ENGINE_HTTP_PORT}/metrics | grep -E '^blocky_(denylist_cache_entries|last_list_group_refresh_timestamp_seconds|failed_downloads_total)'`
    ]);
    if (result.code !== 0 || !result.output.trim()) return null;
    return parseEngineMetrics(result.output);
}

/**
 * Ask the engine for one name the way a device on the network would (the
 * default group: no device of its own), and say whether it was blocked and by
 * what. Through the query API on the container loopback, with the name passed
 * as an argument and never through a shell.
 */
export async function lookupName(domain: string): Promise<DnsLookup> {
    const target = await engine();
    const result = await target.ports.runIn(target.container, [
        "wget",
        "-qO-",
        "--header",
        "Content-Type: application/json",
        "--post-data",
        JSON.stringify({ query: domain, type: "A" }),
        `http://127.0.0.1:${DNS_ENGINE_HTTP_PORT}/api/query`
    ]);
    const lookup = result.code === 0 ? parseLookup(domain, result.output) : null;
    if (!lookup) {
        console.error("polaris: network filter lookup failed:", result.output);
        throw new DnsBlockerRefusal("notAnswering");
    }
    return lookup;
}

/** Download every list again now, rather than at the next scheduled time. */
export async function refreshLists(): Promise<void> {
    await blocky(await engine(), ["lists", "refresh"]);
}

/** Let every lookup through for a while, or until resumed when `seconds` is 0. */
export async function pauseBlocking(seconds: number): Promise<void> {
    await blocky(
        await engine(),
        seconds > 0 ? ["blocking", "disable", "--duration", `${seconds}s`] : ["blocking", "disable"]
    );
}

/** End a pause early. */
export async function resumeBlocking(): Promise<void> {
    await blocky(await engine(), ["blocking", "enable"]);
}

/** One hour of the last day's lookups. */
export interface HourCount {
    readonly allowed: number;
    readonly blocked: number;
}

/** The last 24 hours without the rows, for the Overview's card. */
export interface DnsBlockerSummary {
    readonly queries: number;
    readonly blocked: number;
    readonly blockedPercent: number;
    /** Hour by hour, oldest first, ending with the current hour. */
    readonly hourly: readonly HourCount[];
    readonly pause: DnsInsights["pause"];
}

/** Adds the timeline's bars up into whole hours. */
export function hourlyFrom(stats: QueryStats): HourCount[] {
    const { bucketMs, allowed, blocked } = stats.timeline;
    const per = Math.max(1, Math.round(3_600_000 / bucketMs));
    const hours: HourCount[] = [];
    for (let start = 0; start < allowed.length; start += per) {
        const sum = (bars: readonly number[]) =>
            bars.slice(start, start + per).reduce((total, count) => total + count, 0);
        hours.push({ allowed: sum(allowed), blocked: sum(blocked) });
    }
    return hours;
}

/**
 * The last 24 hours' totals and whether blocking is paused, or null when the
 * DNS server is not running. Read through the same unfiltered log read as the
 * app's own screen, so the two share it rather than each copying the file.
 */
export async function dnsBlockerSummary(fresh = false): Promise<DnsBlockerSummary | null> {
    let insights: DnsInsights;
    try {
        insights = await dnsInsights(queryFilterSchema.parse({}), fresh);
    } catch (error) {
        if (error instanceof DnsBlockerRefusal && error.code === "notRunning") return null;
        throw error;
    }
    const { queries, blocked, blockedPercent } = insights.stats;
    return {
        queries,
        blocked,
        blockedPercent,
        hourly: hourlyFrom(insights.stats),
        pause: insights.pause
    };
}

/**
 * Fold every finished day the DNS server's log still holds, and Polaris has
 * no row for, into one row a day, then drop the rows past the history kept.
 * Run by the `dns-blocker-history` job; a day already rolled up costs one
 * indexed read, and a day is read one file at a time.
 */
export async function rollUpHistory(now = Date.now()): Promise<{ added: number; pruned: number }> {
    const { count: pruned } = await prisma.dnsBlockerDay.deleteMany({
        where: { day: { lt: new Date(utcDay(now) - DNS_HISTORY_DAYS * 86_400_000) } }
    });
    let target: Engine;
    try {
        target = await engine();
    } catch (error) {
        if (error instanceof DnsBlockerRefusal) return { added: 0, pruned };
        throw error;
    }
    const settings = await readSettings();
    const days = finishedDays(now, Math.min(settings.logDays + 1, DNS_HISTORY_BACKFILL_DAYS));
    const held = await prisma.dnsBlockerDay.findMany({
        where: { day: { gte: new Date(days[days.length - 1] ?? now) } },
        select: { day: true }
    });
    const done = new Set(held.map((row) => utcDay(row.day.getTime())));
    const { page: _page, ...filter } = queryFilterSchema.parse({});
    let added = 0;
    for (const day of days) {
        if (done.has(day)) continue;
        const reader = new QueryLogReader(filter, dayWindow(day));
        if (!(await readLog(target, queryLogPath(new Date(day)), reader))) continue;
        const row = dayRow(day, reader.stats());
        const { count } = await prisma.dnsBlockerDay.createMany({
            data: [
                {
                    ...row,
                    hourly: row.hourly as Prisma.InputJsonValue,
                    topPermitted: row.topPermitted as Prisma.InputJsonValue,
                    topBlocked: row.topBlocked as Prisma.InputJsonValue,
                    topClients: row.topClients as Prisma.InputJsonValue,
                    topBlockedClients: row.topBlockedClients as Prisma.InputJsonValue,
                    blockedBy: row.blockedBy as Prisma.InputJsonValue
                }
            ],
            // Two passes at once write the same day once.
            skipDuplicates: true
        });
        added += count;
    }
    return { added, pruned };
}

/** The days of a range, added up, for the Overview's long-term card. */
export async function dnsHistory(range: DnsHistoryRange, now = Date.now()): Promise<DnsHistory> {
    const from = utcDay(now) - DNS_HISTORY_RANGES[range] * 86_400_000;
    const rows = await prisma.dnsBlockerDay.findMany({
        where: { day: { gte: new Date(from) } },
        orderBy: { day: "asc" },
        select: {
            day: true,
            queries: true,
            blocked: true,
            clients: true,
            topPermitted: true,
            topBlocked: true,
            topClients: true,
            topBlockedClients: true,
            blockedBy: true
        }
    });
    return historyFrom(
        rows.map((row) => ({ ...row, hourly: [] })),
        range,
        now
    );
}
