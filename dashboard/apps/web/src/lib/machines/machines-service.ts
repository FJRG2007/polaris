/**
 * Servers, their containers and the domains that answer for them, as devices in
 * Places. Nothing here collects anything: the cards come from the same readers
 * Watch draws (watch-overview-service), domain health from the columns the
 * health probe already writes, and the history from Watch's alarm events.
 *
 * Owner-scoped, as Watch is: a server, a container and a domain are the
 * account's own. Server-only.
 */

import { prisma } from "@polaris/db";
import type { AlarmEventPoint } from "@/lib/machines/alarm-episodes";
import { inPlaces } from "@/lib/machines/machine-links";
import { getWatchContainers, getWatchServers, type WatchCard } from "@/lib/watch-overview-service";

export { machineHref, type MachineKind } from "@/lib/machines/machine-links";

/** How far back a device screen reads its alarm history. */
export const HISTORY_DAYS = 90;
/** Events read per screen; a machine that fired more than this in 90 days has
 *  its oldest left out rather than the page held up. */
const MAX_EVENTS = 2000;
const MAX_DOMAINS = 200;

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

export async function machineDomains(ownerId: string, id?: string): Promise<DomainDevice[]> {
    const rows = await prisma.domain.findMany({
        where: { ...(id ? { id } : {}), application: { environment: { project: { ownerId } } } },
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
        take: MAX_DOMAINS
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
