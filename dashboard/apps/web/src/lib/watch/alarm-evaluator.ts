/**
 * Watch alarm evaluator. On an interval, evaluates each enabled alarm against
 * recent metrics (CPU/memory from MetricSample) or reachability (domain health,
 * app running state), tracks a breach streak so a blip does not fire, and on a
 * state transition (ok <-> alarm) records an AlarmEvent, raises an in-app
 * notification, and optionally messages a channel. Same poller shape as
 * auto-deploy-poller: idempotent start, unref'd interval, delayed first pass.
 */

import { prisma } from "@polaris/db";
import { createNotification } from "@/lib/notification-service";
import { bridgeSend } from "@/lib/messaging/bridge-client";

const INTERVAL_MS = Number(process.env.POLARIS_ALARM_POLL_MS) || 60_000;
const FIRST_PASS_MS = 25_000;
const RECENT_SAMPLE_MS = 3 * 60_000;

let started = false;

interface AlarmRow {
    id: string;
    ownerId: string;
    name: string;
    targetType: string;
    targetId: string;
    metric: string;
    operator: string;
    threshold: number | null;
    forPeriods: number;
    state: string;
    breachStreak: number;
    notifyChannelId: string | null;
    notifyPeerId: string | null;
}

interface Evaluation {
    breach: boolean;
    value: number | null;
    detail: string;
    /** No data to judge on; keep the streak, mark the alarm insufficient. */
    insufficient: boolean;
}

async function evaluateCondition(alarm: AlarmRow): Promise<Evaluation> {
    // Domain reachability (or an app's http metric pointed at a domain id).
    if (alarm.targetType === "domain" || alarm.metric === "http") {
        const domain = await prisma.domain.findFirst({
            where: { id: alarm.targetId },
            select: { healthStatus: true, healthDetail: true }
        });
        if (!domain) return { breach: false, value: null, detail: "Domain not found", insufficient: true };
        if (domain.healthStatus !== "up" && domain.healthStatus !== "down") {
            return { breach: false, value: null, detail: "Not checked yet", insufficient: true };
        }
        const breach = domain.healthStatus === "down";
        return { breach, value: null, detail: breach ? (domain.healthDetail ?? "unreachable") : "reachable", insufficient: false };
    }

    // App service liveness: down if it should be up but has no recent metrics.
    if (alarm.metric === "service") {
        const app = await prisma.application.findFirst({
            where: { id: alarm.targetId },
            select: { desiredState: true }
        });
        if (!app) return { breach: false, value: null, detail: "App not found", insufficient: true };
        if (app.desiredState !== "running") {
            return { breach: false, value: null, detail: "stopped (not expected up)", insufficient: false };
        }
        const sample = await prisma.metricSample.findFirst({
            where: { subjectType: "app", subjectId: alarm.targetId },
            orderBy: { ts: "desc" },
            select: { ts: true }
        });
        const recent = sample !== null && Date.now() - sample.ts.getTime() < RECENT_SAMPLE_MS;
        return { breach: !recent, value: null, detail: recent ? "running" : "no recent metrics (down?)", insufficient: false };
    }

    // CPU / memory threshold from the latest sample.
    const sample = await prisma.metricSample.findFirst({
        where: { subjectType: "app", subjectId: alarm.targetId },
        orderBy: { ts: "desc" },
        select: { ts: true, cpuPercent: true, memUsedBytes: true, memTotalBytes: true }
    });
    if (sample === null || Date.now() - sample.ts.getTime() >= RECENT_SAMPLE_MS) {
        return { breach: false, value: null, detail: "no recent metrics", insufficient: true };
    }
    let value: number | null;
    if (alarm.metric === "cpu") {
        value = sample.cpuPercent ?? null;
    } else {
        const used = sample.memUsedBytes;
        const total = sample.memTotalBytes;
        value = used !== null && total !== null && total > 0n ? (Number(used) / Number(total)) * 100 : null;
    }
    if (value === null) return { breach: false, value: null, detail: "metric unavailable", insufficient: true };
    const threshold = alarm.threshold ?? 0;
    const breach = alarm.operator === "lt" ? value < threshold : value > threshold;
    return {
        breach,
        value,
        detail: `${alarm.metric} ${value.toFixed(1)}% (threshold ${alarm.operator} ${threshold})`,
        insufficient: false
    };
}

async function notifyTransition(alarm: AlarmRow, kind: "triggered" | "resolved", detail: string): Promise<void> {
    const triggered = kind === "triggered";
    await createNotification({
        userId: alarm.ownerId,
        type: triggered ? "watch.alarm" : "watch.ok",
        title: triggered ? `Alarm: ${alarm.name}` : `Recovered: ${alarm.name}`,
        body: detail,
        level: triggered ? "danger" : "success",
        href: "/watch",
        metadata: { alarmId: alarm.id }
    });
    if (alarm.notifyChannelId && alarm.notifyPeerId) {
        try {
            await bridgeSend(alarm.notifyChannelId, {
                peerId: alarm.notifyPeerId,
                text: `${triggered ? "ALARM" : "Recovered"}: ${alarm.name} - ${detail}`
            });
        } catch {
            // The channel may be disconnected; the in-app notification still fired.
        }
    }
}

async function evaluateOne(alarm: AlarmRow): Promise<void> {
    const result = await evaluateCondition(alarm);
    let state = alarm.state;
    let streak = alarm.breachStreak;
    let transition: "triggered" | "resolved" | null = null;

    if (result.insufficient) {
        state = "insufficient";
    } else if (result.breach) {
        streak = alarm.breachStreak + 1;
        if (streak >= alarm.forPeriods) {
            if (alarm.state !== "alarm") transition = "triggered";
            state = "alarm";
        } else {
            state = alarm.state === "alarm" ? "alarm" : "ok";
        }
    } else {
        streak = 0;
        if (alarm.state === "alarm") transition = "resolved";
        state = "ok";
    }

    await prisma.alarm.update({
        where: { id: alarm.id },
        data: { state, breachStreak: streak, lastEvaluatedAt: new Date() }
    });

    if (transition) {
        await prisma.alarmEvent.create({
            data: { alarmId: alarm.id, kind: transition, value: result.value, detail: result.detail }
        });
        await notifyTransition(alarm, transition, result.detail);
    }
}

export async function evaluateAlarms(): Promise<void> {
    const alarms = await prisma.alarm.findMany({ where: { enabled: true } });
    for (const alarm of alarms) {
        try {
            await evaluateOne(alarm);
        } catch (error) {
            console.error("polaris: alarm evaluation failed:", error);
        }
    }
}

export function startAlarmEvaluator(): void {
    if (started) return;
    started = true;
    const tick = (): void => {
        void evaluateAlarms().catch((error) => console.error("polaris: alarm evaluator tick failed:", error));
    };
    setTimeout(tick, FIRST_PASS_MS).unref();
    setInterval(tick, INTERVAL_MS).unref();
}
