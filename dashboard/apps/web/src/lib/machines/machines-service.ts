/**
 * Servers, their containers and the domains that answer for them, as devices in
 * Places. Nothing here collects anything: the cards come from the same readers
 * Watch draws (watch-overview-service), domain health from the columns the
 * health probe already writes, and the history from Watch's alarm events.
 *
 * Owner-scoped, as Watch is: a server, a container and a domain are the
 * account's own - except a server or a domain lent to them to watch
 * (machine-access), which is read as its owner's and nothing more. Server-only.
 */

import { prisma, type Prisma } from "@polaris/db";
import { grantedSubjects } from "@/lib/access/grants";
import { isLocalMachine, localMachineIdentity } from "@/lib/local-machine";
import type { AlarmEventPoint } from "@/lib/machines/alarm-episodes";
import { inPlaces } from "@/lib/machines/machine-links";
import {
    getWatchContainerPage,
    getWatchContainers,
    getWatchServerPage,
    getWatchServers,
    type WatchCard
} from "@/lib/watch-overview-service";

export { machineHref, type MachineKind } from "@/lib/machines/machine-links";

/** How far back a device screen reads its alarm history. */
export const HISTORY_DAYS = 90;
/** Events read per screen; a machine that fired more than this in 90 days has
 *  its oldest left out rather than the page held up. */
const MAX_EVENTS = 2000;
const MAX_DOMAINS = 200;
/** Servers per page of the Places list, and machines whose containers are
 *  listed per page - each of those is a round trip to its engine. */
export const SERVER_PAGE = 24;
export const CONTAINER_MACHINE_PAGE = 8;
export const DOMAIN_PAGE = 50;

/** A page of a machines group, and where the next one starts. */
export interface MachinePage<T> {
    readonly items: T[];
    readonly next: string | null;
}

export interface DomainDevice {
    readonly id: string;
    readonly hostname: string;
    readonly service: string;
    readonly serviceId: string;
    readonly projectId: string;
    readonly status: "up" | "down" | null;
    readonly code: number | null;
    readonly latencyMs: number | null;
    readonly detail: string | null;
    readonly checkedAt: string | null;
}

export async function machineServers(ownerId: string): Promise<WatchCard[]> {
    return (await getWatchServers(ownerId)).map(inPlaces);
}

export async function machineContainers(ownerId: string): Promise<WatchCard[]> {
    return (await getWatchContainers(ownerId)).map(inPlaces);
}

/** A page of the account's servers as cards, the machine Polaris runs on first. */
export async function machineServerPage(
    ownerId: string,
    cursor: string | null
): Promise<MachinePage<WatchCard>> {
    const page = await getWatchServerPage(ownerId, cursor, SERVER_PAGE);
    return { items: page.cards.map(inPlaces), next: page.next };
}

/** The containers on a page of the account's machines. */
export async function machineContainerPage(
    ownerId: string,
    cursor: string | null
): Promise<MachinePage<WatchCard>> {
    const page = await getWatchContainerPage(ownerId, cursor, CONTAINER_MACHINE_PAGE);
    return { items: page.cards.map(inPlaces), next: page.next };
}

/** A page of the account's domains by hostname, continued on it (it is unique). */
export async function machineDomainPage(
    ownerId: string,
    cursor: string | null
): Promise<MachinePage<DomainDevice>> {
    const after = decodeHostnameCursor(cursor);
    const rows = await readDomains(
        {
            application: { environment: { project: { ownerId } } },
            ...(after ? { hostname: { gt: after } } : {})
        },
        DOMAIN_PAGE + 1
    );
    const items = rows.slice(0, DOMAIN_PAGE);
    const last = items[items.length - 1];
    return {
        items,
        next: rows.length > DOMAIN_PAGE && last ? encodeHostnameCursor(last.hostname) : null
    };
}

function encodeHostnameCursor(hostname: string): string {
    return Buffer.from(JSON.stringify([hostname])).toString("base64url");
}

function decodeHostnameCursor(raw: string | null): string | null {
    if (!raw || raw.length > 1024) return null;
    try {
        const [hostname] = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as unknown[];
        return typeof hostname === "string" ? hostname : null;
    } catch {
        return null;
    }
}

/** One of the account's containers as Watch lists it, its link still into
 *  Containers. */
export async function machineContainer(ownerId: string, id: string): Promise<WatchCard | null> {
    return (await getWatchContainers(ownerId)).find((card) => card.id === id) ?? null;
}

/**
 * The servers lent to this account to watch, as cards: each owner's own cards,
 * cut to the lent ones, with where the server lives left out. The machine
 * Polaris runs on never appears here, whatever a row says.
 */
export async function lentMachineServers(userId: string, lentLabel: string): Promise<WatchCard[]> {
    const lent = [...(await grantedSubjects(userId, "place.server")).keys()];
    if (lent.length === 0) return [];
    const [hosts, identity] = await Promise.all([
        prisma.host.findMany({
            where: { id: { in: lent }, ownerId: { not: userId } },
            select: { id: true, ownerId: true, address: true, dockerId: true },
            take: MAX_DOMAINS
        }),
        localMachineIdentity()
    ]);
    const byOwner = new Map<string, Set<string>>();
    for (const host of hosts) {
        if (isLocalMachine(host, identity)) continue;
        byOwner.set(host.ownerId, (byOwner.get(host.ownerId) ?? new Set()).add(host.id));
    }
    const perOwner = await Promise.all(
        [...byOwner].map(async ([ownerId, ids]) =>
            (await getWatchServers(ownerId)).filter((card) => ids.has(card.id))
        )
    );
    return perOwner.flat().map((card) => ({ ...inPlaces(card), detail: lentLabel }));
}

/** The domains lent to this account to watch, with the service behind each
 *  left out. */
export async function lentMachineDomains(userId: string, id?: string): Promise<DomainDevice[]> {
    const lent = [...(await grantedSubjects(userId, "place.domain")).keys()].filter(
        (entry) => !id || entry === id
    );
    if (lent.length === 0) return [];
    const rows = await readDomains({
        id: { in: lent },
        application: { environment: { project: { ownerId: { not: userId } } } }
    });
    return rows.map((row) => ({ ...row, service: "", serviceId: "", projectId: "" }));
}

export async function machineDomains(ownerId: string, id?: string): Promise<DomainDevice[]> {
    return readDomains({
        ...(id ? { id } : {}),
        application: { environment: { project: { ownerId } } }
    });
}

async function readDomains(
    where: Prisma.DomainWhereInput,
    take: number = MAX_DOMAINS
): Promise<DomainDevice[]> {
    const rows = await prisma.domain.findMany({
        where,
        select: {
            id: true,
            hostname: true,
            healthStatus: true,
            healthCode: true,
            healthLatencyMs: true,
            healthDetail: true,
            healthCheckedAt: true,
            application: {
                select: { id: true, name: true, environment: { select: { projectId: true } } }
            }
        },
        orderBy: { hostname: "asc" },
        take
    });
    return rows.map((row) => ({
        id: row.id,
        hostname: row.hostname,
        service: row.application.name,
        serviceId: row.application.id,
        projectId: row.application.environment.projectId,
        status: row.healthStatus === "up" || row.healthStatus === "down" ? row.healthStatus : null,
        code: row.healthCode,
        latencyMs: row.healthLatencyMs,
        detail: row.healthDetail,
        checkedAt: row.healthCheckedAt?.toISOString() ?? null
    }));
}

/** The alarm events on these subjects over the history window, oldest first. */
export async function machineAlarmEvents(
    ownerId: string,
    targetIds: readonly string[],
    now = Date.now()
): Promise<{ since: number; events: AlarmEventPoint[] }> {
    const since = now - HISTORY_DAYS * 86_400_000;
    if (targetIds.length === 0) return { since, events: [] };
    const rows = await prisma.alarmEvent.findMany({
        where: {
            createdAt: { gte: new Date(since) },
            alarm: { ownerId, targetId: { in: [...targetIds] } }
        },
        select: { alarmId: true, kind: true, createdAt: true, alarm: { select: { name: true } } },
        orderBy: { createdAt: "desc" },
        take: MAX_EVENTS
    });
    return {
        since,
        events: rows.reverse().map((row) => ({
            alarmId: row.alarmId,
            alarmName: row.alarm.name,
            kind: row.kind,
            at: row.createdAt.getTime()
        }))
    };
}
