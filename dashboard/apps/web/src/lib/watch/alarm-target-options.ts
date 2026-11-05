/**
 * What an alarm or a threshold trigger may watch, a page at a time: the owner's
 * services, servers and domains, searched and ordered (name, id) in the
 * database, so a picker never holds more than the pages somebody scrolled
 * through. The scope is exactly the one `assertOwnsTarget` checks when the
 * alarm is saved.
 */

import { prisma, type Prisma } from "@polaris/db";
import { LOCAL_HOST_SUBJECT } from "@/lib/metrics-shared";
import { decodeServerCursor, encodeServerCursor } from "@/lib/server-options";
import { getLocalServerName, LOCAL_SERVER_FALLBACK_NAME } from "@/lib/local-server";
import {
    isLocalMachine,
    localMachineIdentity,
    type LocalMachineIdentity
} from "@/lib/local-machine";
import { pageOf, type OptionsPage, type PageRequest } from "@/lib/deploy-target-options";

export type AlarmTargetKind = "application" | "host" | "domain";

export interface AlarmTargetOption {
    readonly id: string;
    readonly name: string;
    /** Servers only: false for one reached over SSH, whose disk nothing here reads. */
    readonly measuresDisk?: boolean;
}

function searchAnd<W>(field: string, request: PageRequest): W[] {
    const and: Record<string, unknown>[] = [];
    if (request.ids) and.push({ id: { in: [...request.ids] } });
    if (request.query) and.push({ [field]: { contains: request.query, mode: "insensitive" } });
    const after = decodeServerCursor(request.cursor);
    if (after) {
        and.push({
            OR: [{ [field]: { gt: after.name } }, { [field]: after.name, id: { gt: after.id } }]
        });
    }
    return and as W[];
}

/** The owner's servers that are this machine, by the same test `isLocalMachine` makes. */
function localWhere(identity: LocalMachineIdentity): Prisma.HostWhereInput[] {
    return [
        ...(identity.hostId ? [{ id: identity.hostId }] : []),
        ...(identity.dockerId ? [{ dockerId: identity.dockerId }] : []),
        ...[...identity.addresses].map((address) => ({
            address: { equals: address, mode: "insensitive" as const }
        }))
    ];
}

async function hostOptions(
    ownerId: string,
    request: PageRequest
): Promise<OptionsPage<AlarmTargetOption>> {
    const identity = await localMachineIdentity().catch(() => null);
    const rows = await prisma.host.findMany({
        where: { AND: [{ ownerId }, ...searchAnd<Prisma.HostWhereInput>("name", request)] },
        select: { id: true, name: true, dockerId: true, address: true },
        orderBy: [{ name: "asc" }, { id: "asc" }],
        take: request.limit + 1
    });
    const page = pageOf(rows, request.limit, (host) => ({
        id: host.id,
        name: host.name,
        measuresDisk: identity ? isLocalMachine(host, identity) : false
    }));
    // The machine Polaris runs on is one target however it is known: its enrolled
    // server row when it has one, its reserved subject - offered first - when not.
    const wantsLocal = request.ids ? request.ids.includes(LOCAL_HOST_SUBJECT) : !request.cursor;
    if (!wantsLocal) return page;
    const enrolled =
        identity && localWhere(identity).length > 0
            ? await prisma.host.findFirst({
                  where: { ownerId, OR: localWhere(identity) },
                  select: { id: true }
              })
            : null;
    if (enrolled) return page;
    const name = (await getLocalServerName().catch(() => null)) ?? LOCAL_SERVER_FALLBACK_NAME;
    if (request.query && !name.toLowerCase().includes(request.query.toLowerCase())) return page;
    return {
        ...page,
        items: [{ id: LOCAL_HOST_SUBJECT, name, measuresDisk: true }, ...page.items]
    };
}

export async function alarmTargetOptions(
    ownerId: string,
    kind: AlarmTargetKind,
    request: PageRequest
): Promise<OptionsPage<AlarmTargetOption>> {
    if (kind === "host") return hostOptions(ownerId, request);
    if (kind === "application") {
        const rows = await prisma.application.findMany({
            where: {
                AND: [
                    { environment: { project: { ownerId } } },
                    ...searchAnd<Prisma.ApplicationWhereInput>("name", request)
                ]
            },
            select: { id: true, name: true },
            orderBy: [{ name: "asc" }, { id: "asc" }],
            take: request.limit + 1
        });
        return pageOf(rows, request.limit, ({ id, name }) => ({ id, name }));
    }
    const rows = await prisma.domain.findMany({
        where: {
            AND: [
                { application: { environment: { project: { ownerId } } } },
                ...searchAnd<Prisma.DomainWhereInput>("hostname", request)
            ]
        },
        select: { id: true, hostname: true },
        orderBy: [{ hostname: "asc" }, { id: "asc" }],
        take: request.limit + 1
    });
    const page = rows.slice(0, request.limit);
    const last = page[page.length - 1];
    return {
        items: page.map((row) => ({ id: row.id, name: row.hostname })),
        next:
            rows.length > request.limit && last ? encodeServerCursor(last.hostname, last.id) : null
    };
}

/** A UPS page, for an instance administrator - as every UPS screen is. */
export async function upsOptions(request: PageRequest): Promise<OptionsPage<AlarmTargetOption>> {
    const rows = await prisma.ups.findMany({
        where: { AND: searchAnd<Prisma.UpsWhereInput>("name", request) },
        select: { id: true, name: true },
        orderBy: [{ name: "asc" }, { id: "asc" }],
        take: request.limit + 1
    });
    return pageOf(rows, request.limit, ({ id, name }) => ({ id, name }));
}
