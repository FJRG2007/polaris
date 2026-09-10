/**
 * What running services print: followed live, kept, and searched.
 *
 * Three readers of one thing. The live view follows every container of the
 * services on screen as they write - one stream per container, merged by
 * docker's own stamp so replicas read as one log. The capture keeps it: once a
 * minute it reads each running container's tail and stores the lines newer than
 * the last one it has, which is what lets a crash at three in the morning still
 * be read after the deploy that replaced the container. And the search reads
 * what was kept, across services and a time range, a page at a time.
 *
 * The capture is a tail read rather than a standing stream on purpose: a stream
 * per container held open forever is a connection per container per server that
 * has to be kept alive and re-opened after every deploy, and a missed minute
 * costs nothing that the next read does not pick up. A service louder than the
 * tail between two reads keeps its newest lines and loses the middle ones - said
 * on the screen rather than hidden.
 *
 * The readers act as the project owner, on the services `readableServices`
 * handed back - which is where the person asking is authorized.
 */

import { prisma } from "@polaris/db";
import type { RuntimePorts } from "@polaris/deploy";
import { getPorts, type TargetRow } from "./runtime";
import { currentReleaseRef, type ReleaseSubject } from "./releases";
import { requireApplicationAccess } from "@/lib/deploy-project-access";
import { LineSplitter, linesAfter, splitStamp, stampDate, type StampedLine } from "./log-chunks";

/** How long kept lines are kept. */
export const RUNTIME_LOG_RETENTION_DAYS = 7;

/** The most lines kept per service, whatever their age. A chatty service fills
 *  this in a day and a quiet one never reaches it; either way the store is
 *  bounded by the number of services rather than by how much they print. */
export const RUNTIME_LOG_MAX_LINES = 50_000;

/** How much of each container's tail one capture reads. */
export const CAPTURE_TAIL = 1000;

/** How many lines one insert carries. */
const INSERT_BATCH = 500;

/** What the host daemon appends when a streamed command exits non-zero. */
const EXIT_TRAILER = /^\[polaris:exit:-?\d+\]$/;

/** One line as a reader sees it. */
export interface RuntimeLogEntry {
    readonly serviceId: string;
    readonly container: string;
    readonly stamp: string | null;
    readonly text: string;
}

/** A service as the readers here need it loaded. */
export type LoggedService = ReleaseSubject & { target: unknown; environment: { project: { slug: string; ownerId: string } } };

/**
 * The containers a service's output comes from: every running replica, found by
 * the labels its engine put on them, or its own container when the engine
 * lists none (or cannot be asked).
 */
export async function serviceContainers(ports: RuntimePorts, app: ReleaseSubject): Promise<string[]> {
    const release = await currentReleaseRef(app);
    const listed = ports.listContainers ? await ports.listContainers(release.project).catch(() => []) : [];
    return listed.length > 0 ? listed : [release.name];
}

/**
 * The services of `ids` this person may read the logs of, loaded with what
 * following them takes. One they may not read, or that does not exist, is
 * simply absent: a list of ids from a query string can narrow what is read and
 * never widen it.
 */
export async function readableServices(
    userId: string,
    ids: readonly string[]
): Promise<(LoggedService & { id: string; name: string })[]> {
    const allowed: string[] = [];
    for (const id of ids) {
        const access = await requireApplicationAccess(id, userId, "logs.read").catch(() => null);
        if (access) allowed.push(id);
    }
    if (allowed.length === 0) return [];
    return prisma.application.findMany({
        where: { id: { in: allowed } },
        orderBy: { name: "asc" },
        select: {
            id: true,
            name: true,
            slug: true,
            currentDeploymentId: true,
            target: true,
            environment: { select: { project: { select: { slug: true, ownerId: true } } } }
        }
    });
}

/** The running services to capture, with what reaching them takes. */
async function runningServices() {
    return prisma.application.findMany({
        where: { currentDeploymentId: { not: null }, desiredState: "running" },
        select: {
            id: true,
            slug: true,
            currentDeploymentId: true,
            targetId: true,
            target: true,
            environment: { select: { project: { select: { slug: true, ownerId: true } } } }
        }
    });
}

/**
 * Keep what every running service printed since the last capture.
 *
 * One connection per server rather than per service, the way the metrics
 * collector does it: a server with ten services is one session a minute, not
 * ten. A service or server that cannot be read this minute is skipped; the next
 * capture reads the same tail and finds the lines it missed, as long as the
 * service has not printed more than a tail's worth since.
 */
export async function captureRuntimeLogs(): Promise<{ services: number; lines: number }> {
    const services = await runningServices();
    const byTarget = new Map<string, typeof services>();
    for (const service of services) {
        const group = byTarget.get(service.targetId);
        if (group) group.push(service);
        else byTarget.set(service.targetId, [service]);
    }

    let captured = 0;
    let lines = 0;
    for (const group of byTarget.values()) {
        const first = group[0];
        if (!first) continue;
        let ports: RuntimePorts | null = null;
        try {
            ports = await getPorts(first.target as TargetRow, first.environment.project.ownerId);
            for (const service of group) {
                try {
                    lines += await captureService(ports, service);
                    captured += 1;
                } catch {
                    // One service that cannot be read must not cost the rest.
                }
            }
        } catch {
            // The server is unreachable this minute.
        } finally {
            if (ports) await ports.dispose().catch(() => undefined);
        }
    }
    return { services: captured, lines };
}

async function captureService(ports: RuntimePorts, service: LoggedService & { id: string }): Promise<number> {
    let stored = 0;
    for (const container of await serviceContainers(ports, service)) {
        const last = await prisma.runtimeLogLine.findFirst({
            where: { applicationId: service.id, container },
            orderBy: { stamp: "desc" },
            select: { stamp: true }
        });
        const splitter = new LineSplitter();
        const raw: string[] = [];
        await ports.logs(container, (chunk) => raw.push(...splitter.push(chunk)), { tail: CAPTURE_TAIL });
        raw.push(...splitter.flush());
        const fresh = linesAfter(raw.map(splitStamp), last?.stamp ?? null);
        for (let at = 0; at < fresh.length; at += INSERT_BATCH) {
            const batch = fresh.slice(at, at + INSERT_BATCH) as (StampedLine & { stamp: string })[];
            await prisma.runtimeLogLine.createMany({
                data: batch.map((line) => ({
                    applicationId: service.id,
                    container,
                    stamp: line.stamp,
                    at: stampDate(line.stamp),
                    text: line.text
                }))
            });
        }
        stored += fresh.length;
    }
    return stored;
}

/**
 * Keep the store inside its bounds: nothing older than the retention, and no
 * service over its count. Answers how many lines went.
 *
 * The count is enforced by finding the stamp of the newest line past the cap
 * and removing everything at or before it, which is one query per service that
 * is over rather than a scan of every line.
 */
export async function pruneRuntimeLogs(now = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - RUNTIME_LOG_RETENTION_DAYS * 24 * 3_600_000);
    let removed = (await prisma.runtimeLogLine.deleteMany({ where: { at: { lt: cutoff } } })).count;

    const counts = await prisma.runtimeLogLine.groupBy({ by: ["applicationId"], _count: { _all: true } });
    for (const row of counts) {
        if (row._count._all <= RUNTIME_LOG_MAX_LINES) continue;
        const edge = await prisma.runtimeLogLine.findFirst({
            where: { applicationId: row.applicationId },
            orderBy: { stamp: "desc" },
            skip: RUNTIME_LOG_MAX_LINES,
            select: { stamp: true }
        });
        if (!edge) continue;
        removed += (
            await prisma.runtimeLogLine.deleteMany({
                where: { applicationId: row.applicationId, stamp: { lte: edge.stamp } }
            })
        ).count;
    }
    return removed;
}

/** A search over kept lines. */
export interface RuntimeLogQuery {
    readonly serviceIds: readonly string[];
    /** A phrase the line contains, any case. */
    readonly text?: string;
    readonly from?: Date;
    readonly to?: Date;
    /** Where the previous page ended, as `next` handed it back. */
    readonly before?: string;
    readonly limit: number;
}

export interface RuntimeLogPage {
    /** Newest first. */
    readonly lines: (RuntimeLogEntry & { readonly id: string; readonly stamp: string })[];
    /** Pass as `before` for the next, older page; null when there is none. */
    readonly next: string | null;
}

/** The cursor form: the stamp and the id, so two lines with one stamp still page. */
export function encodeCursor(stamp: string, id: string): string {
    return `${stamp}|${id}`;
}

export function decodeCursor(cursor: string | undefined): { stamp: string; id: string } | null {
    if (!cursor) return null;
    const at = cursor.lastIndexOf("|");
    if (at <= 0) return null;
    const stamp = cursor.slice(0, at);
    const id = cursor.slice(at + 1);
    return /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(stamp) && /^[0-9a-f-]{36}$/i.test(id) ? { stamp, id } : null;
}

/**
 * A page of kept lines, newest first. Filtered in the database - by service, by
 * time, by phrase - and paged by cursor, so a reader scrolling back through a
 * week of output never asks for more than one page at a time.
 */
export async function searchRuntimeLogs(query: RuntimeLogQuery): Promise<RuntimeLogPage> {
    const cursor = decodeCursor(query.before);
    const rows = await prisma.runtimeLogLine.findMany({
        where: {
            applicationId: { in: [...query.serviceIds] },
            ...(query.text ? { text: { contains: query.text, mode: "insensitive" as const } } : {}),
            ...(query.from || query.to
                ? { at: { ...(query.from ? { gte: query.from } : {}), ...(query.to ? { lte: query.to } : {}) } }
                : {}),
            ...(cursor
                ? { OR: [{ stamp: { lt: cursor.stamp } }, { stamp: cursor.stamp, id: { lt: cursor.id } }] }
                : {})
        },
        orderBy: [{ stamp: "desc" }, { id: "desc" }],
        take: query.limit + 1,
        select: { id: true, applicationId: true, container: true, stamp: true, text: true }
    });
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
        lines: page.map((row) => ({
            id: row.id,
            serviceId: row.applicationId,
            container: row.container,
            stamp: row.stamp,
            text: row.text
        })),
        next: rows.length > query.limit && last ? encodeCursor(last.stamp, last.id) : null
    };
}

/**
 * Follow every container of the given services until `signal` aborts.
 *
 * Each container is its own stream from `tail` lines back, split into whole
 * lines as it arrives and handed on in small batches, so a burst of output is
 * one message rather than hundreds. A container that ends or cannot be followed
 * is reported through `onEnded` and the others carry on.
 */
export async function followRuntimeLogs(input: {
    services: readonly (LoggedService & { id: string })[];
    tail: number;
    signal: AbortSignal;
    onFollowing: (serviceId: string, containers: string[]) => void;
    onLines: (lines: RuntimeLogEntry[]) => void;
    onEnded: (serviceId: string, container: string, reason: string | null) => void;
}): Promise<void> {
    const pending: RuntimeLogEntry[] = [];
    const flush = (): void => {
        if (pending.length === 0) return;
        input.onLines(pending.splice(0, pending.length));
    };
    const timer = setInterval(flush, 200);
    input.signal.addEventListener("abort", () => clearInterval(timer), { once: true });

    const follows: Promise<void>[] = [];
    const opened: RuntimePorts[] = [];
    for (const service of input.services) {
        if (input.signal.aborted) break;
        let ports: RuntimePorts;
        try {
            // Tied to the reader's connection: when it goes, the far side stops
            // the follow, rather than leaving it running on the server.
            ports = await getPorts(service.target as TargetRow, service.environment.project.ownerId, input.signal);
            opened.push(ports);
        } catch {
            input.onEnded(service.id, "", "The server this service runs on could not be reached.");
            continue;
        }
        const containers = await serviceContainers(ports, service).catch(() => [] as string[]);
        input.onFollowing(service.id, containers);
        for (const container of containers) {
            const splitter = new LineSplitter();
            const push = (raw: string[]): void => {
                for (const line of raw) {
                    // The daemon's own note that the command failed, not output.
                    if (EXIT_TRAILER.test(line)) continue;
                    const parsed = splitStamp(line);
                    pending.push({ serviceId: service.id, container, stamp: parsed.stamp, text: parsed.text });
                }
            };
            follows.push(
                ports
                    .logs(container, (chunk) => push(splitter.push(chunk)), { tail: input.tail, follow: true })
                    .then(
                        () => {
                            push(splitter.flush());
                            input.onEnded(service.id, container, null);
                        },
                        () => {
                            if (!input.signal.aborted) {
                                input.onEnded(service.id, container, "The output stopped. The container may have been replaced.");
                            }
                        }
                    )
            );
        }
    }
    await Promise.allSettled(follows);
    clearInterval(timer);
    flush();
    await Promise.allSettled(opened.map((ports) => ports.dispose()));
}
