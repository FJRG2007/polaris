/**
 * Watch control plane: CRUD for alarms and reads for the Watch UI. Evaluation and
 * firing live in the alarm-evaluator poller; this module only manages the alarm
 * records and surfaces their state and event history. Everything is owner-scoped.
 */

import { prisma } from "@polaris/db";
import type { AlarmInput } from "@/lib/watch/watch-schema";

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
    domains: { id: string; hostname: string }[];
}

/** Apps and domains the owner can watch, for the create form. */
export async function listAlarmTargets(ownerId: string): Promise<AlarmTargets> {
    const [apps, domains] = await Promise.all([
        prisma.application.findMany({
            where: { environment: { project: { ownerId } } },
            select: { id: true, name: true },
            orderBy: { name: "asc" }
        }),
        prisma.domain.findMany({
            where: { application: { environment: { project: { ownerId } } } },
            select: { id: true, hostname: true },
            orderBy: { hostname: "asc" }
        })
    ]);
    return { apps, domains };
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
    const rows = await prisma.alarm.findMany({ where: { ownerId }, orderBy: { createdAt: "desc" } });
    return rows.map(toView);
}

/** Confirm the target app/domain belongs to the owner before creating an alarm. */
async function assertOwnsTarget(ownerId: string, targetType: string, targetId: string): Promise<void> {
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

export async function setAlarmEnabled(ownerId: string, id: string, enabled: boolean): Promise<void> {
    const alarm = await prisma.alarm.findFirst({ where: { id, ownerId }, select: { id: true } });
    if (!alarm) throw new Error("Alarm not found");
    // Re-enabling resets the streak/state so a stale breach does not fire instantly.
    await prisma.alarm.update({
        where: { id: alarm.id },
        data: enabled ? { enabled: true, state: "insufficient", breachStreak: 0 } : { enabled: false }
    });
}

export async function deleteAlarm(ownerId: string, id: string): Promise<void> {
    const alarm = await prisma.alarm.findFirst({ where: { id, ownerId }, select: { id: true } });
    if (!alarm) throw new Error("Alarm not found");
    await prisma.alarm.delete({ where: { id: alarm.id } });
}

/** Recent alarm events across the owner's alarms, newest first. */
export async function listRecentAlarmEvents(ownerId: string, limit = 50): Promise<AlarmEventView[]> {
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
