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
    parseBlockingStatus,
    queryLogPath,
    type QueryFilter,
    type QueryRow,
    type QueryStats
} from "./query-log";

const BLOCKY = "/app/blocky";

/** How long one read of the day's log answers the same filter again. */
const LOG_TTL_MS = 10_000;
/** How many filters' reads are kept at once. */
const LOG_CACHE_MAX = 32;

export interface DnsInsights {
    readonly stats: QueryStats;
    readonly rows: readonly QueryRow[];
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
    readonly rows: readonly QueryRow[];
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

/** One read of the day's log per filter for a few seconds, shared by whoever
 *  asks meanwhile, so refreshes and several admins do not each copy the file. */
function cachedLog(target: Engine, filter: QueryFilter, fresh: boolean): Promise<LogRead> {
    const path = queryLogPath(new Date());
    const key = JSON.stringify([target.container, path, filter]);
    const now = Date.now();
    const hit = logReads.get(key);
    if (hit && !fresh && now - hit.at < LOG_TTL_MS) return hit.read;
    const reader = new QueryLogReader(filter);
    const read = readLog(target, path, reader).then((found) => ({
        found,
        stats: reader.stats(),
        rows: reader.newest()
    }));
    const entry = { at: now, read };
    read.catch(() => {
        if (logReads.get(key) === entry) logReads.delete(key);
    });
    for (const [other, { at }] of logReads) if (now - at >= LOG_TTL_MS) logReads.delete(other);
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

/** Today's numbers, the newest lookups that match, and whether blocking is paused. */
export async function dnsInsights(filter: QueryFilter, fresh = false): Promise<DnsInsights> {
    const target = await engine();
    const [log, status] = await Promise.all([
        cachedLog(target, filter, fresh),
        blocky(target, ["blocking", "status"])
    ]);
    const logOff = !log.found && !(await engineConfigCurrent(target.row));
    return { stats: log.stats, rows: log.rows, pause: parseBlockingStatus(status), logOff };
}

/** Let every lookup through for a while; blocking comes back on by itself. */
export async function pauseBlocking(minutes: number): Promise<void> {
    await blocky(await engine(), ["blocking", "disable", "--duration", `${minutes}m`]);
}

/** End a pause early. */
export async function resumeBlocking(): Promise<void> {
    await blocky(await engine(), ["blocking", "enable"]);
}
