/**
 * Watch control plane: CRUD for alarms and reads for the Watch UI. Evaluation and
 * firing live in the alarm-evaluator poller; this module only manages the alarm
 * records and surfaces their state and event history. Everything is owner-scoped.
 */

import { prisma } from "@polaris/db";
import { LOCAL_HOST_SUBJECT } from "@/lib/metrics-shared";
import type { AlarmInput } from "@/lib/watch/watch-schema";
import { isLocalMachine, localMachineIdentity } from "@/lib/local-machine";
import { getLocalServerName, LOCAL_SERVER_FALLBACK_NAME } from "@/lib/local-server";

export interface AlarmView {
    id: string;
    name: string;
    targetType: string;
    targetId: string;
    metric: string;
    operator: string;
    threshold: number | null;
    forPeriods: number;
    enabled: boolean;
    state: string;
    lastEvaluatedAt: string | null;
}

export interface AlarmEventView {
    id: string;
    alarmId: string;
    alarmName: string;
    kind: string;
    value: number | null;
    detail: string | null;
    createdAt: string;
}

export interface AlarmTargets {
    apps: { id: string; name: string }[];
    /** `measuresDisk` is false for a server reached over SSH: nothing here can
     *  read its filesystem, so a disk alarm on it would never have a reading. */
    hosts: { id: string; name: string; measuresDisk: boolean }[];
    domains: { id: string; hostname: string }[];
}

/** Apps, servers and domains the owner can watch, for the create form. */
export async function listAlarmTargets(ownerId: string): Promise<AlarmTargets> {
    const [apps, hosts, domains, identity, localName] = await Promise.all([
        prisma.application.findMany({
            where: { environment: { project: { ownerId } } },
            select: { id: true, name: true },
            orderBy: { name: "asc" }
        }),
        prisma.host.findMany({
            where: { ownerId },
            select: { id: true, name: true, dockerId: true, address: true },
            orderBy: { name: "asc" }
        }),
        prisma.domain.findMany({
            where: { application: { environment: { project: { ownerId } } } },
            select: { id: true, hostname: true },
            orderBy: { hostname: "asc" }
        }),
        localMachineIdentity().catch(() => null),
        getLocalServerName().catch(() => null)
    ]);
    // The machine Polaris runs on is one target however it is known: its enrolled
    // server row when it has one, its reserved subject when it does not.
    const servers = hosts.map((host) => ({
        id: host.id,
        name: host.name,
        measuresDisk: identity ? isLocalMachine(host, identity) : false
    }));
    if (!servers.some((server) => server.measuresDisk)) {
        servers.unshift({
            id: LOCAL_HOST_SUBJECT,
            name: localName ?? LOCAL_SERVER_FALLBACK_NAME,
            measuresDisk: true
        });
    }
    return { apps, hosts: servers, domains };
}

function toView(row: {
    id: string;
    name: string;
    targetType: string;
    targetId: string;
    metric: string;
    operator: string;
    threshold: number | null;
    forPeriods: number;
    enabled: boolean;
    state: string;
    lastEvaluatedAt: Date | null;
}): AlarmView {
    return {
        id: row.id,
        name: row.name,
        targetType: row.targetType,
        targetId: row.targetId,
        metric: row.metric,
        operator: row.operator,
        threshold: row.threshold,
        forPeriods: row.forPeriods,
        enabled: row.enabled,
        state: row.state,
        lastEvaluatedAt: row.lastEvaluatedAt?.toISOString() ?? null
    };
}

export async function listAlarms(ownerId: string): Promise<AlarmView[]> {
    const rows = await prisma.alarm.findMany({
        where: { ownerId },
        orderBy: { createdAt: "desc" }
    });
    return rows.map(toView);
}

/** Confirm the target belongs to the owner before creating an alarm. */
async function assertOwnsTarget(
    ownerId: string,
    targetType: string,
    targetId: string
): Promise<void> {
    if (targetType === "host") {
        // The machine Polaris runs on has no row to own until it is enrolled, and
        // belongs to whoever is watching it - as its metrics already do.
        if (targetId === LOCAL_HOST_SUBJECT) return;
        const host = await prisma.host.findFirst({
            where: { id: targetId, ownerId },
            select: { id: true }
        });
        if (!host) throw new Error("The selected server was not found");
        return;
    }
    if (targetType === "application") {
        const app = await prisma.application.findFirst({
            where: { id: targetId, environment: { project: { ownerId } } },
            select: { id: true }
        });
        if (!app) throw new Error("The selected app was not found");
        return;
    }
    const domain = await prisma.domain.findFirst({
        where: { id: targetId, application: { environment: { project: { ownerId } } } },
        select: { id: true }
    });
    if (!domain) throw new Error("The selected domain was not found");
}

export async function createAlarm(ownerId: string, input: AlarmInput): Promise<string> {
    await assertOwnsTarget(ownerId, input.targetType, input.targetId);
    const alarm = await prisma.alarm.create({
        data: {
            ownerId,
            name: input.name,
            targetType: input.targetType,
            targetId: input.targetId,
            metric: input.metric,
            operator: input.operator,
            threshold: input.threshold ?? null,
            forPeriods: input.forPeriods,
            notifyChannelId: input.notifyChannelId ?? null,
            notifyPeerId: input.notifyPeerId ?? null
        }
    });
    return alarm.id;
}

export async function setAlarmEnabled(
    ownerId: string,
    id: string,
    enabled: boolean
): Promise<void> {
    const alarm = await prisma.alarm.findFirst({ where: { id, ownerId }, select: { id: true } });
    if (!alarm) throw new Error("Alarm not found");
    // Re-enabling resets the streak/state so a stale breach does not fire instantly.
    await prisma.alarm.update({
        where: { id: alarm.id },
        data: enabled
            ? { enabled: true, state: "insufficient", breachStreak: 0 }
            : { enabled: false }
    });
}

export async function deleteAlarm(ownerId: string, id: string): Promise<void> {
    const alarm = await prisma.alarm.findFirst({ where: { id, ownerId }, select: { id: true } });
    if (!alarm) throw new Error("Alarm not found");
    await prisma.alarm.delete({ where: { id: alarm.id } });
}

/** Recent alarm events across the owner's alarms, newest first. */
export async function listRecentAlarmEvents(
    ownerId: string,
    limit = 50
): Promise<AlarmEventView[]> {
    const rows = await prisma.alarmEvent.findMany({
        where: { alarm: { ownerId } },
        orderBy: { createdAt: "desc" },
        take: limit,
        include: { alarm: { select: { name: true } } }
    });
    return rows.map((row) => ({
        id: row.id,
        alarmId: row.alarmId,
        alarmName: row.alarm.name,
        kind: row.kind,
        value: row.value,
        detail: row.detail,
        createdAt: row.createdAt.toISOString()
    }));
}
