/**
 * Containers an agent session or a sign-in left running after it ended.
 *
 * Every way a session or a sign-in ends takes its container down - Stop, a
 * failed start, the sweep of sessions that went silent, the sweep of sign-ins
 * nobody finished - but each of them swallows a teardown that fails, because
 * the person is answered either way. So a daemon that did not answer at that
 * moment left a container running for good: one stopped on 2 September was still
 * up three weeks later, holding its memory, with nothing that would ever look at
 * it again.
 *
 * This is the look. It starts from what is running rather than from what the
 * database says ended, so it also catches a container whose row is gone.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import { HostdClient } from "@polaris/hostd-client";
import { HostdPorts } from "@/lib/deploy/ports-hostd";
import { endContainerSession, releaseContainer } from "./session-work";
import { reservedSpareIds } from "./session-spares";

/** How long after its end a container is left alone: the teardown that ended it
 *  may still be running. A container with no row at all gets the same time from
 *  when it was made, in case its row is still being written. */
export const ENDED_GRACE_MS = 5 * 60_000;

const KINDS = [
    { prefix: "polaris-session-", kind: "session" },
    { prefix: "polaris-signin-", kind: "signin" }
] as const;

type Kind = (typeof KINDS)[number]["kind"];

/** One container as the daemon listed it. */
export interface ListedContainer {
    readonly name: string;
    readonly project: string | null;
    readonly createdAt: Date;
}

/** What Polaris knows about the thing a container ran for: when it ended, or
 *  null while it is still going. Absent from the map when there is no row. */
export type EndedAt = ReadonlyMap<string, Date | null>;

/**
 * The compose projects to take down: containers of one kind whose owner ended
 * long enough ago, or no longer exists at all.
 *
 * Pure, so every branch can be asserted without a daemon.
 */
export function leftoverProjects(
    listed: readonly ListedContainer[],
    prefix: string,
    ended: EndedAt,
    now: Date
): string[] {
    const projects = new Set<string>();
    for (const container of listed) {
        const project = container.project ?? container.name;
        if (!project.startsWith(prefix)) continue;
        const id = project.slice(prefix.length);
        if (!id) continue;
        if (!ended.has(id)) {
            if (now.getTime() - container.createdAt.getTime() >= ENDED_GRACE_MS)
                projects.add(project);
            continue;
        }
        const at = ended.get(id) ?? null;
        if (at && now.getTime() - at.getTime() >= ENDED_GRACE_MS) projects.add(project);
    }
    return [...projects];
}

async function listed(daemon: HostdClient, prefix: string): Promise<ListedContainer[] | null> {
    const filters = encodeURIComponent(JSON.stringify({ name: [prefix] }));
    const reply = await daemon
        .dockerRequest("GET", `/containers/json?all=1&filters=${filters}`)
        .catch(() => null);
    if (!reply || reply.status !== 200) return null;
    try {
        const entries = JSON.parse(reply.body) as {
            Names?: string[];
            Labels?: Record<string, string>;
            Created?: number;
        }[];
        return entries.map((entry) => ({
            name: (entry.Names?.[0] ?? "").replace(/^\//, ""),
            project: entry.Labels?.["com.docker.compose.project"] ?? null,
            // Seconds since the epoch; a missing one reads as just made.
            createdAt: new Date(
                typeof entry.Created === "number" ? entry.Created * 1000 : Date.now()
            )
        }));
    } catch {
        return null;
    }
}

interface Ended {
    readonly at: Map<string, Date | null>;
    /** Sessions whose work was never looked at: one that ended through its own
     *  events rather than Stop or the sweep. Saved before their container goes. */
    readonly unsaved: Set<string>;
}

async function endedAt(kind: Kind, ids: string[]): Promise<Ended> {
    if (ids.length === 0) return { at: new Map(), unsaved: new Set() };
    if (kind === "session") {
        const rows = await prisma.agentSession.findMany({
            where: { id: { in: ids } },
            select: { id: true, state: true, finishedAt: true, workState: true, containerId: true }
        });
        const unsaved = new Set(
            rows.filter((row) => row.workState === null && row.containerId).map((row) => row.id)
        );
        const at = new Map(
            rows.map((row) => [
                row.id,
                // Kept on purpose: its work could not be pushed, and the
                // container is the only copy until somebody pushes or discards it.
                (row.state === "stopped" || row.state === "failed") && row.workState !== "kept"
                    ? (row.finishedAt ?? new Date(0))
                    : null
            ])
        );
        return { at, unsaved };
    }
    const rows = await prisma.agentSigninAttempt.findMany({
        where: { id: { in: ids } },
        select: { id: true, endedAt: true }
    });
    return { at: new Map(rows.map((row) => [row.id, row.endedAt])), unsaved: new Set() };
}

/** Take down every leftover container on this machine. Returns how many went. */
export async function reapLeftoverContainers(now = new Date()): Promise<number> {
    const daemon = new HostdClient();
    // A spare waiting for its message has no session row yet; it is the spare
    // sweep's (`session-spares`), not this one's.
    const spares = await reservedSpareIds().catch(() => null);
    if (!spares) return 0;
    let reaped = 0;
    for (const { prefix, kind } of KINDS) {
        const containers = await listed(daemon, prefix);
        // A daemon that will not say what is running is not a list of nothing.
        if (!containers || containers.length === 0) continue;
        const ids = containers
            .map((container) => (container.project ?? container.name).slice(prefix.length))
            .filter((id) => /^[0-9a-f-]{36}$/i.test(id));
        const ended = await endedAt(kind, ids);
        for (const project of leftoverProjects(containers, prefix, ended.at, now)) {
            // Only an id-shaped name, so nothing else that happens to share the
            // prefix is ever taken down.
            const id = project.slice(prefix.length);
            if (!/^[0-9a-f-]{36}$/i.test(id)) continue;
            if (kind === "session" && spares.has(id)) continue;
            if (ended.unsaved.has(id)) {
                const outcome = await endContainerSession(id).catch((error) => {
                    console.error(`polaris: could not save the work of session ${id}:`, error);
                    return null;
                });
                if (outcome && outcome.kind !== "kept") reaped += 1;
                continue;
            }
            // A session takes its checkout with it. See `releaseContainer`.
            if (kind === "session") {
                await releaseContainer(project);
                reaped += 1;
                continue;
            }
            await new HostdPorts()
                .composeDown(project)
                .then(() => (reaped += 1))
                .catch(() => undefined);
        }
    }
    return reaped;
}

/**
 * The same clean-up for the containers placed on pool servers.
 *
 * The box is asked what it runs, because a container there can outlive any
 * record of it. A pool server is not: listing every server's containers on
 * every pass is a connection per server per minute, and a container is only
 * ever placed there by a session row that names the server. So the rows are
 * the list - an ended session that still names a container, past its grace,
 * with its work not kept - and `containerId` is cleared once it is taken down,
 * so each one is visited once. Bounded per pass.
 */
export async function reapPoolLeftovers(now = new Date(), batch = 50): Promise<number> {
    const rows = await prisma.agentSession.findMany({
        where: {
            place: "local",
            hostId: { not: null },
            containerId: { not: null },
            state: { in: ["stopped", "failed"] },
            finishedAt: { lt: new Date(now.getTime() - ENDED_GRACE_MS) },
            OR: [{ workState: null }, { workState: { not: "kept" } }]
        },
        select: { id: true, hostId: true, containerId: true, workState: true },
        orderBy: { finishedAt: "asc" },
        take: batch
    });
    let reaped = 0;
    for (const row of rows) {
        if (!row.containerId) continue;
        if (row.workState === null) {
            const outcome = await endContainerSession(row.id).catch(() => null);
            if (!outcome || outcome.kind === "kept") continue;
        } else {
            await releaseContainer(row.containerId, row.hostId);
        }
        await prisma.agentSession
            .update({ where: { id: row.id }, data: { containerId: null } })
            .then(() => (reaped += 1))
            .catch(() => undefined);
    }
    return reaped;
}
