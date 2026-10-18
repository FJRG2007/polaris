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
import { DnsBlockerRefusal, engineRow } from "./service";
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

export interface DnsInsights {
    readonly stats: QueryStats;
    readonly rows: readonly QueryRow[];
    readonly pause: { readonly enabled: boolean; readonly secondsLeft: number | null };
}

interface Engine {
    readonly ports: RuntimePorts;
    readonly container: string;
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
    return { ports, container };
}

async function readLog(target: Engine, reader: QueryLogReader): Promise<void> {
    let stream: ReadableStream<Uint8Array>;
    try {
        stream = await target.ports.readFile(target.container, queryLogPath(new Date()));
    } catch {
        // No file yet: nothing has been asked today.
        return;
    }
    const decoder = new TextDecoder();
    let rest = "";
    for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
        const lines = (rest + decoder.decode(chunk, { stream: true })).split("\n");
        rest = lines.pop() ?? "";
        for (const line of lines) reader.add(line);
    }
    reader.add(rest + decoder.decode());
}

async function blocky(target: Engine, args: readonly string[]): Promise<string> {
    const result = await target.ports.runIn(target.container, [BLOCKY, ...args]);
    if (result.code !== 0) {
        console.error("polaris: ad blocker command failed:", result.output);
        throw new DnsBlockerRefusal("notRunning");
    }
    return result.output;
}

/** Today's numbers, the newest lookups that match, and whether blocking is paused. */
export async function dnsInsights(filter: QueryFilter): Promise<DnsInsights> {
    const target = await engine();
    const reader = new QueryLogReader(filter);
    const [, status] = await Promise.all([
        readLog(target, reader),
        blocky(target, ["blocking", "status"])
    ]);
    return { stats: reader.stats(), rows: reader.newest(), pause: parseBlockingStatus(status) };
}

/** Let every lookup through for a while; blocking comes back on by itself. */
export async function pauseBlocking(minutes: number): Promise<void> {
    await blocky(await engine(), ["blocking", "disable", "--duration", `${minutes}m`]);
}

/** End a pause early. */
export async function resumeBlocking(): Promise<void> {
    await blocky(await engine(), ["blocking", "enable"]);
}
