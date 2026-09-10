/**
 * Watch alarm evaluator. On an interval, evaluates each enabled alarm against
 * recent metrics (CPU, memory, disk and network from MetricSample, for a service
 * or a server) or reachability (domain health, app running state), tracks a
 * breach streak so a blip does not fire, and on a
 * state transition (ok <-> alarm) records an AlarmEvent, raises the alert through
 * the account's notification rules, and optionally messages a channel. Same
 * poller shape as auto-deploy-poller: idempotent start, unref'd interval,
 * delayed first pass.
 */

import { prisma } from "@polaris/db";
import { notify } from "@/lib/notifications/dispatch";
import { bridgeSend } from "@/lib/messaging/bridge-client";
import { COLLECT_TICK_MS, LOCAL_HOST_SUBJECT, STORAGE_EVERY_TICKS } from "@/lib/metrics-shared";
import { isLocalMachine, localMachineIdentity, type LocalMachineIdentity } from "@/lib/local-machine";
import {
    alarmUnit,
    breaches,
    formatAlarmValue,
    formatThreshold,
    METRIC_LABEL,
    sampleValue,
    volumeDiskGb
} from "./alarm-metrics";

const INTERVAL_MS = Number(process.env.POLARIS_ALARM_POLL_MS) || 60_000;
const FIRST_PASS_MS = 25_000;
const RECENT_SAMPLE_MS = 3 * 60_000;
/** Volumes are measured on the slower storage cadence; three of those missed in a
 *  row is a volume nothing can read, rather than one between measurements. */
const RECENT_VOLUME_MS = 3 * STORAGE_EVERY_TICKS * COLLECT_TICK_MS;

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

async function evaluateCondition(alarm: AlarmRow, context: PassContext): Promise<Evaluation> {
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

    const unit = alarmUnit(alarm.metric, alarm.targetType);
    if (unit === null) return { breach: false, value: null, detail: "unknown metric", insufficient: true };

    // A service's disk is what its volumes hold, measured as subjects of their own.
    const value =
        alarm.metric === "disk" && alarm.targetType === "application"
            ? await serviceDiskGb(alarm.targetId)
            : await subjectValue(alarm, context);
    if (typeof value === "string") return { breach: false, value: null, detail: value, insufficient: true };

    const threshold = alarm.threshold ?? 0;
    const label = METRIC_LABEL[alarm.metric as keyof typeof METRIC_LABEL] ?? alarm.metric;
    return {
        breach: breaches(value, alarm.operator, threshold),
        value,
        detail: `${label} ${formatAlarmValue(value, unit)} (threshold ${formatThreshold(alarm.operator, threshold, unit)})`,
        insufficient: false
    };
}

/** What one pass knows once rather than per alarm. */
interface PassContext {
    identity: LocalMachineIdentity | null;
}

/**
 * The metric subject an alarm reads: the service itself, or the server - where
 * the machine Polaris runs on is filed under its reserved subject whichever way
 * the alarm names it, since that is where its samples are.
 */
async function subjectOf(alarm: AlarmRow, context: PassContext): Promise<{ type: "app" | "host"; id: string }> {
    if (alarm.targetType !== "host") return { type: "app", id: alarm.targetId };
    if (alarm.targetId === LOCAL_HOST_SUBJECT) return { type: "host", id: LOCAL_HOST_SUBJECT };
    const host = await prisma.host.findFirst({
        where: { id: alarm.targetId },
        select: { id: true, dockerId: true, address: true }
    });
    context.identity ??= await localMachineIdentity().catch(() => null);
    const local = host && context.identity ? isLocalMachine(host, context.identity) : false;
    return { type: "host", id: local ? LOCAL_HOST_SUBJECT : alarm.targetId };
}

/** The alarm's metric from its subject's latest sample, or why there is none. */
async function subjectValue(alarm: AlarmRow, context: PassContext): Promise<number | string> {
    const subject = await subjectOf(alarm, context);
    // The newest two: a rate is worked out between them.
    const [latest, previous] = await prisma.metricSample.findMany({
        where: { subjectType: subject.type, subjectId: subject.id },
        orderBy: { ts: "desc" },
        take: 2,
        select: {
            ts: true,
            cpuPercent: true,
            memUsedBytes: true,
            memTotalBytes: true,
            diskUsedBytes: true,
            diskTotalBytes: true,
            netRxBytes: true,
            netTxBytes: true
        }
    });
    if (!latest || Date.now() - latest.ts.getTime() >= RECENT_SAMPLE_MS) return "no recent metrics";
    const value = sampleValue(alarm.metric, latest, previous ?? null);
    if (value !== null) return value;
    if (alarm.metric === "disk") return "this server's disk is not measured";
    return "metric unavailable";
}

/** What a service's volumes hold, from each one's latest measurement. */
async function serviceDiskGb(applicationId: string): Promise<number | string> {
    const volumes = await prisma.volume.findMany({ where: { applicationId }, select: { id: true } });
    if (volumes.length === 0) return "the service has no volumes";
    const since = new Date(Date.now() - RECENT_VOLUME_MS);
    const readings = await Promise.all(
        volumes.map((volume) =>
            prisma.metricSample.findFirst({
                where: { subjectType: "volume", subjectId: volume.id, ts: { gte: since } },
                orderBy: { ts: "desc" },
                select: { diskUsedBytes: true }
            })
        )
    );
    const value = volumeDiskGb(readings.filter((reading) => reading !== null));
    return value === null ? "no recent volume measurement" : value;
}

async function notifyTransition(alarm: AlarmRow, kind: "triggered" | "resolved", detail: string): Promise<void> {
    const triggered = kind === "triggered";
    await notify({
        userId: alarm.ownerId,
        event: triggered ? "watch.alarm" : "watch.ok",
        title: triggered ? `Alarm: ${alarm.name}` : `Recovered: ${alarm.name}`,
        body: detail,
        actionRequired: triggered,
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

async function evaluateOne(alarm: AlarmRow, context: PassContext): Promise<void> {
    const result = await evaluateCondition(alarm, context);
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
    const context: PassContext = { identity: null };
    for (const alarm of alarms) {
        try {
            await evaluateOne(alarm, context);
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
