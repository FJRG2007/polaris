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

import { prisma } from "@polaris/db";
import type { RuntimePorts } from "@polaris/deploy";
import { DnsBlockerRefusal, engineConfigCurrent, engineRow } from "./service";
import { getPorts, type TargetRow } from "@/lib/deploy/runtime";
import { resolveContainerName } from "@/lib/container-files-service";
import {
    QueryLogReader,
    TAIL_BYTES,
    parseBlockingStatus,
    parseEngineMetrics,
    parseTail,
    queryLogPath,
    rangeWindow,
    type EngineMetrics,
    type QueryFilter,
    type QueryPage,
    type QueryRow,
    type QueryStats
} from "./query-log";
import { DNS_ENGINE_HTTP_PORT } from "./render";

const BLOCKY = "/app/blocky";

/** How long one read of the log answers the same filter again: a range that
 *  reaches into past days costs a file per day, and moves by the bar anyway. */
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
    readonly log: QueryPage;
}

const logReads = new Map<string, { readonly at: number; readonly read: Promise<LogRead> }>();

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

/** One read of the log per filter for a few seconds, shared by whoever asks
 *  meanwhile, so refreshes and several admins do not each copy the files. */
function cachedLog(target: Engine, filter: QueryFilter, fresh: boolean): Promise<LogRead> {
    const now = Date.now();
    const window = rangeWindow(filter.range, now);
    const ttl = LOG_TTL_MS[filter.range];
    const key = JSON.stringify([target.container, filter]);
    const hit = logReads.get(key);
    if (hit && !fresh && now - hit.at < ttl) return hit.read;
    const reader = new QueryLogReader(filter, window);
    const read = readDays(target, window.days, reader).then((found) => ({
        found,
        stats: reader.stats(),
        log: reader.page()
    }));
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
        console.error("polaris: ad blocker command failed:", result.output);
        throw new DnsBlockerRefusal("notAnswering");
    }
    return result.output;
}

/** The range's numbers, one page of the lookups that match, and whether
 *  blocking is paused. */
export async function dnsInsights(filter: QueryFilter, fresh = false): Promise<DnsInsights> {
    const target = await engine();
    const [log, status] = await Promise.all([
        cachedLog(target, filter, fresh),
        blocky(target, ["blocking", "status"])
    ]);
    const logOff = !log.found && !(await engineConfigCurrent(target.row));
    return { stats: log.stats, log: log.log, pause: parseBlockingStatus(status), logOff };
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
