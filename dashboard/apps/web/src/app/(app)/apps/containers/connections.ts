import "server-only";

/**
 * Which Docker hosts a person can reach, resolved once for every screen in the
 * Containers app.
 *
 * Three things are hosts here and none of them look alike: the local engine
 * brokered by the daemon, a server registered in the Servers app reached over
 * SSH, and a Docker connection somebody stored by hand. Working out that set -
 * and, more delicately, that the local engine and one of those servers are the
 * same machine under two names - is the same job for the list and for one
 * container's page, so it is done here rather than twice.
 *
 * Nothing in here talks to a Docker engine. It answers from the database and
 * from hostd's own capability report, which is what lets both pages paint before
 * a possibly-remote engine has said anything.
 */

import { z } from "zod";
import { prisma } from "@polaris/db";
import type { DockerTransport } from "@polaris/docker";
import { capabilitiesFor } from "@/lib/host-capabilities";
import { userHasManage, type SessionUser } from "@/lib/session";
import { isLocalMachine, localMachineIdentity } from "@/lib/local-machine";
import type { DockerConnectionSummary, LocalHostDiagnostic } from "./types";
import { HOST_DOCKER_PREFIX, LOCAL_DOCKER_CONNECTION_ID } from "@/lib/docker-service";

/** Hosts drawn in the switcher before anybody searches. */
const FIRST_PAGE = 25;

export const connectionOptionsInput = z
    .object({
        query: z.string().trim().max(120).default(""),
        cursor: z.string().max(1024).nullable().default(null),
        limit: z.number().int().min(1).max(50).default(FIRST_PAGE),
        /** Read these back by id - how the picker names a chosen host. */
        ids: z.array(z.string().min(1).max(80)).min(1).max(20).optional()
    })
    .strict();

export type ConnectionOptionsRequest = z.output<typeof connectionOptionsInput>;

/** What every page of hosts is read against: who may see the local engine, and
 *  which registered server is that same machine. */
export interface ConnectionContext {
    canManage: boolean;
    localAvailable: boolean;
    localDiagnostic: LocalHostDiagnostic | null;
    sameMachine: { id: string; name: string } | null;
}

export interface ContainerHosts {
    connections: DockerConnectionSummary[];
    /** Whether this person may manage the system, which is what the local engine
     *  and every lifecycle control are gated on. */
    canManage: boolean;
    /** Why the local host is missing, for an admin who should have one. */
    localDiagnostic: LocalHostDiagnostic | null;
    /** Whether there are hosts past the first page, reached through the picker. */
    more: boolean;
}

export async function connectionContext(user: SessionUser): Promise<ConnectionContext> {
    // The local host is host-wide, so it is only offered to operators who may
    // manage the system, and only in the full edition (hostd reports docker).
    // The daemon is probed directly whenever the cached snapshot says there is no
    // Docker, so the local host shows the moment hostd reports it. When the
    // snapshot already says Docker is there, it is trusted, so the ordinary visit
    // does not wait on the daemon before it paints.
    const canManage = await userHasManage(user, "system.manage");
    const [caps, identity] = await Promise.all([
        canManage ? capabilitiesFor("docker") : null,
        localMachineIdentity()
    ]);
    const localAvailable = Boolean(caps?.docker);

    // When an admin has no local host, explain WHY (edition / hostd / socket) so
    // it is diagnosable instead of a silent "connect a host" prompt.
    const localDiagnostic: LocalHostDiagnostic | null =
        canManage && caps && !caps.docker
            ? {
                  edition: caps.edition,
                  hostdPresent: caps.hostd.present,
                  hostdVersion: caps.hostd.version,
                  dockerReported: caps.docker,
                  reason: !caps.hostd.present
                      ? // Said in what the reader can see and do from here: no screen
                        // in Polaris asks for a terminal, a file or a container.
                        "This Polaris runs without its host daemon, so it cannot manage the containers on the machine it runs on. Connect a server to manage its containers instead."
                      : "The host daemon is running but cannot reach Docker on this machine, so its containers cannot be listed. Connect a server to manage its containers instead."
              }
            : null;

    // A registered server can be the very machine Polaris runs on. Offering both
    // is one engine under two names, listing the same containers twice - so when
    // the local host is on the menu, that server is it, under its own name. It
    // still appears on its own when the local host is not offered, which is what
    // keeps an operator who may not manage the system able to reach it. Found by
    // the machine's own identity, so no page has to hold every server to find it.
    let sameMachine: { id: string; name: string } | null = null;
    if (localAvailable) {
        const addresses = [...identity.addresses];
        const candidates = await prisma.host.findMany({
            where: {
                ownerId: user.id,
                OR: [
                    ...(identity.hostId ? [{ id: identity.hostId }] : []),
                    ...(identity.dockerId ? [{ dockerId: identity.dockerId }] : []),
                    ...(addresses.length > 0
                        ? [{ address: { in: addresses, mode: "insensitive" as const } }]
                        : [])
                ]
            },
            select: { id: true, name: true, address: true, dockerId: true },
            orderBy: { createdAt: "asc" },
            take: 5
        });
        const found = candidates.find((host) => isLocalMachine(host, identity));
        sameMachine = found ? { id: found.id, name: found.name } : null;
    }
    return { canManage, localAvailable, localDiagnostic, sameMachine };
}

function localSummary(ctx: ConnectionContext): DockerConnectionSummary {
    return {
        id: LOCAL_DOCKER_CONNECTION_ID,
        name: ctx.sameMachine?.name ?? "Local host",
        transport: "socket",
        status: "active",
        local: true
    };
}

const storedSummary = (row: {
    id: string;
    name: string;
    transport: string;
    status: string;
}): DockerConnectionSummary => ({
    id: row.id,
    name: row.name,
    transport: row.transport as DockerTransport,
    status: row.status
});

// Global Hosts (managed in the Servers app) appear here as Docker-over-SSH
// targets - a server registered once is usable in Containers too.
const hostSummary = (host: {
    id: string;
    name: string;
    status: string;
}): DockerConnectionSummary => ({
    id: `${HOST_DOCKER_PREFIX}${host.id}`,
    name: host.name,
    transport: "ssh",
    status: host.status,
    host: true,
    hostId: host.id
});

/** Where a page starts: stored connections first, then servers, each by (name, id). */
interface Cursor {
    phase: "stored" | "hosts";
    name: string | null;
    id: string | null;
}

function encodeCursor(cursor: Cursor): string {
    return Buffer.from(JSON.stringify([cursor.phase, cursor.name, cursor.id])).toString(
        "base64url"
    );
}

const cursorSchema = z.tuple([
    z.enum(["stored", "hosts"]),
    z.string().max(300).nullable(),
    z.string().uuid().nullable()
]);

function decodeCursor(raw: string | null): Cursor | null {
    if (!raw) return null;
    try {
        const parsed = cursorSchema.safeParse(
            JSON.parse(Buffer.from(raw, "base64url").toString("utf8"))
        );
        return parsed.success
            ? { phase: parsed.data[0], name: parsed.data[1], id: parsed.data[2] }
            : null;
    } catch {
        return null;
    }
}

function afterKey(cursor: Cursor | null, phase: Cursor["phase"]) {
    if (!cursor || cursor.phase !== phase || cursor.name === null || cursor.id === null) return [];
    return [{ OR: [{ name: { gt: cursor.name } }, { name: cursor.name, id: { gt: cursor.id } }] }];
}

/** One host, by the id the switcher carries, or null for one this person cannot reach. */
export async function resolveConnection(
    user: SessionUser,
    ctx: ConnectionContext,
    id: string
): Promise<DockerConnectionSummary | null> {
    if (id === LOCAL_DOCKER_CONNECTION_ID)
        return ctx.localAvailable && ctx.canManage ? localSummary(ctx) : null;
    if (id.startsWith(HOST_DOCKER_PREFIX)) {
        const hostId = id.slice(HOST_DOCKER_PREFIX.length);
        if (!z.string().uuid().safeParse(hostId).success || hostId === ctx.sameMachine?.id)
            return null;
        const host = await prisma.host.findFirst({
            where: { id: hostId, ownerId: user.id },
            select: { id: true, name: true, status: true }
        });
        return host ? hostSummary(host) : null;
    }
    if (!z.string().uuid().safeParse(id).success) return null;
    const row = await prisma.dockerConnection.findFirst({
        where: { id, ownerId: user.id },
        select: { id: true, name: true, transport: true, status: true }
    });
    return row ? storedSummary(row) : null;
}

/**
 * A page of the hosts a person can reach: the local engine first (where it is
 * offered), then their stored connections, then their registered servers, each
 * searched and ordered by name in the database.
 */
export async function connectionOptionsPage(
    user: SessionUser,
    ctx: ConnectionContext,
    request: ConnectionOptionsRequest
): Promise<{ items: DockerConnectionSummary[]; next: string | null }> {
    if (request.ids) {
        const found = await Promise.all(request.ids.map((id) => resolveConnection(user, ctx, id)));
        return { items: found.filter((item) => item !== null), next: null };
    }
    const cursor = decodeCursor(request.cursor);
    const query = request.query;
    const named = query ? [{ name: { contains: query, mode: "insensitive" as const } }] : [];
    const items: DockerConnectionSummary[] = [];
    if (!cursor && ctx.localAvailable) {
        const local = localSummary(ctx);
        if (!query || local.name.toLowerCase().includes(query.toLowerCase())) items.push(local);
    }

    if (!cursor || cursor.phase === "stored") {
        const room = request.limit - items.length;
        const rows = await prisma.dockerConnection.findMany({
            where: { ownerId: user.id, AND: [...named, ...afterKey(cursor, "stored")] },
            select: { id: true, name: true, transport: true, status: true },
            orderBy: [{ name: "asc" }, { id: "asc" }],
            // One past the room: the extra row is how the end is known without counting.
            take: room + 1
        });
        if (rows.length > room) {
            const page = rows.slice(0, room);
            const last = page[page.length - 1]!;
            items.push(...page.map(storedSummary));
            return { items, next: encodeCursor({ phase: "stored", name: last.name, id: last.id }) };
        }
        items.push(...rows.map(storedSummary));
    }

    const room = request.limit - items.length;
    if (room === 0) return { items, next: encodeCursor({ phase: "hosts", name: null, id: null }) };
    const hosts = await prisma.host.findMany({
        where: {
            ownerId: user.id,
            ...(ctx.sameMachine ? { id: { not: ctx.sameMachine.id } } : {}),
            AND: [...named, ...afterKey(cursor, "hosts")]
        },
        select: { id: true, name: true, status: true },
        orderBy: [{ name: "asc" }, { id: "asc" }],
        take: room + 1
    });
    const page = hosts.slice(0, room);
    const last = page[page.length - 1];
    items.push(...page.map(hostSummary));
    return {
        items,
        next:
            hosts.length > room && last
                ? encodeCursor({ phase: "hosts", name: last.name, id: last.id })
                : null
    };
}

/**
 * The switcher's first page, and the host a request named when it is not on
 * that page - so the selection is always drawn, without reading every host.
 */
export async function containerHosts(
    user: SessionUser,
    requested?: string
): Promise<ContainerHosts> {
    const ctx = await connectionContext(user);
    const page = await connectionOptionsPage(user, ctx, connectionOptionsInput.parse({}));
    const chosen =
        requested && !page.items.some((item) => item.id === requested)
            ? await resolveConnection(user, ctx, requested)
            : null;
    return {
        connections: chosen ? [...page.items, chosen] : page.items,
        canManage: ctx.canManage,
        localDiagnostic: ctx.localDiagnostic,
        more: page.next !== null
    };
}

/** The host a request named, or the one it lands on instead. A person who forced
 *  ?c=local into the URL without the permission for it gets the first host they
 *  can actually reach, not a denial for a host they were never shown. */
export function selectConnection(
    hosts: ContainerHosts,
    requested: string | undefined
): DockerConnectionSummary | null {
    const selectable = hosts.connections.filter(
        (connection) => !connection.local || hosts.canManage
    );
    return selectable.find((connection) => connection.id === requested) ?? selectable[0] ?? null;
}
