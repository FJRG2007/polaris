/**
 * Carrying Watch alarms into Automations: a boot step, never a migration, so an
 * install moves after its next Update with nobody doing anything.
 *
 * Each enabled alarm on a reading with a threshold becomes a published, armed
 * automation on its owner's shelf: "When a reading crosses a threshold" on the
 * same subject, metric, comparison, value and streak, recovery on, then one
 * notify step for the alarm and one for the recovery - worded as Watch worded
 * them, delivered where the owner's rules for `watch.alarm` / `watch.ok` sent
 * them, plus the messaging channel and peer the alarm named.
 *
 * Idempotent. The twin is keyed by `legacyRef` ("watch-alarm:<id>"), unique, so
 * a boot that crashed after creating it finds it again and only marks the alarm;
 * two dashboards booting together during an update race on that key, not on a
 * lease. Nothing is deleted: the alarm keeps its definition and history, and
 * from the moment `carriedToId` is set Watch stops evaluating it, so the same
 * crossing is never announced twice. An alarm this cannot express - reachability
 * (`http`, `service`), which has no threshold reading - stays on Watch.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { metricWord } from "@/lib/watch/words";
import { alarmUnit, formatThreshold } from "@/lib/watch/alarm-metrics";

export const WATCH_ALARM_PREFIX = "watch-alarm:";

/** Alarms read per query; the loop takes the rest. */
const BATCH = 50;

/** Watch metrics that are a threshold reading, by the source the trigger reads. */
const SAMPLED = new Set(["cpu", "memory", "disk", "network_in", "network_out"]);

export interface CarriableAlarm {
    readonly id: string;
    readonly ownerId: string;
    readonly name: string;
    readonly targetType: string;
    readonly targetId: string;
    readonly metric: string;
    readonly operator: string;
    readonly threshold: number | null;
    readonly forPeriods: number;
    readonly notifyChannelId: string | null;
    readonly notifyPeerId: string | null;
}

/** The step words, already in the owner's language; `{{...}}` is read at run time. */
export interface CarryWords {
    readonly alarmTitle: string;
    readonly alarmBody: string;
    readonly recoveredTitle: string;
    readonly recoveredBody: string;
}

export type CarryResult =
    | { readonly ok: true; readonly graph: core.AutomationGraph }
    | { readonly ok: false; readonly reason: "reachability" | "noThreshold" | "target" };

/** The threshold source an alarm reads, or null when it has none. */
export function carrySource(alarm: Pick<CarriableAlarm, "targetType" | "metric">): string | null {
    if (!SAMPLED.has(alarm.metric)) return null;
    if (alarm.targetType === "host") return `host.${alarm.metric}`;
    if (alarm.targetType === "application") return `app.${alarm.metric}`;
    return null;
}

/**
 * The automation an alarm is, as a graph. Pure: the words and both deliveries
 * are worked out by the caller, so this can be asserted without a database.
 */
export function watchAlarmGraph(
    alarm: CarriableAlarm,
    words: CarryWords,
    delivery: { readonly alarm: core.NoticeDelivery; readonly recovered: core.NoticeDelivery }
): CarryResult {
    if (alarm.metric === "http" || alarm.metric === "service")
        return { ok: false, reason: "reachability" };
    const source = carrySource(alarm);
    if (!source) return { ok: false, reason: "target" };
    if (alarm.threshold === null || !Number.isFinite(alarm.threshold))
        return { ok: false, reason: "noThreshold" };
    const graph = core.automationGraphSchema.parse({
        schema: 1,
        timeZone: "UTC",
        nodes: [
            {
                id: "reading",
                type: "core.threshold",
                position: { x: 0, y: 0 },
                config: {
                    source,
                    subjectId: alarm.targetId,
                    comparator: alarm.operator === "lt" ? "lt" : "gt",
                    value: alarm.threshold,
                    streak: Math.min(60, Math.max(1, Math.round(alarm.forPeriods))),
                    recovery: true
                }
            },
            {
                id: "which",
                type: "core.switch",
                position: { x: 0, y: 160 },
                config: {
                    kind: "value",
                    value: "{{trigger.state}}",
                    cases: [
                        { label: "", equals: "alarm" },
                        { label: "", equals: "ok" }
                    ],
                    ignoreCase: true,
                    fallback: false
                }
            },
            {
                id: "fired",
                type: "core.notify",
                position: { x: -160, y: 320 },
                config: { title: words.alarmTitle, body: words.alarmBody, delivery: delivery.alarm }
            },
            {
                id: "cleared",
                type: "core.notify",
                position: { x: 160, y: 320 },
                config: {
                    title: words.recoveredTitle,
                    body: words.recoveredBody,
                    delivery: delivery.recovered
                }
            }
        ],
        edges: [
            { from: { node: "reading", port: "next" }, to: { node: "which" } },
            { from: { node: "which", port: "case1" }, to: { node: "fired" } },
            { from: { node: "which", port: "case2" }, to: { node: "cleared" } }
        ]
    });
    return { ok: true, graph };
}

/** Where the owner's rule for an event sent it, as a notify step's delivery. */
export function deliveryFromRule(
    rule: { readonly inapp: boolean; readonly email: boolean; readonly destinations: readonly string[] },
    messaging: core.NoticeDelivery["messaging"]
): core.NoticeDelivery {
    const destinations = rule.destinations.slice(0, 10);
    const anywhere = rule.inapp || rule.email || destinations.length > 0 || messaging !== null;
    return {
        ...core.DEFAULT_NOTICE_DELIVERY,
        // A rule switched off everywhere still left Watch's bell row; keep that.
        bell: rule.inapp || !anywhere,
        email: rule.email,
        destinations,
        messaging
    };
}

/** Everything the graph needs that lives in the database, for one alarm. */
async function carryInputs(alarm: CarriableAlarm) {
    const [{ wordsFor }, { ruleFor }, { mayUseMessagingChannel }] = await Promise.all([
        import("@/lib/notifications/notice-words"),
        import("@/lib/notifications/preferences"),
        import("@/lib/automations/notice-targets")
    ]);
    const [t, firedRule, clearedRule] = await Promise.all([
        wordsFor(alarm.ownerId, "watch"),
        ruleFor(alarm.ownerId, "watch.alarm"),
        ruleFor(alarm.ownerId, "watch.ok")
    ]);
    // A channel the owner no longer has would only ever be a miss; the bell and
    // the rule's own channels still go.
    const messaging =
        alarm.notifyChannelId &&
        alarm.notifyPeerId &&
        (await mayUseMessagingChannel(alarm.ownerId, alarm.notifyChannelId))
            ? { channelId: alarm.notifyChannelId, peerId: alarm.notifyPeerId }
            : null;
    const reading = t("text.reading", {
        metric: metricWord(t, alarm.metric),
        value: "{{trigger.value}}",
        threshold: formatThreshold(
            alarm.operator,
            alarm.threshold ?? 0,
            alarmUnit(alarm.metric, alarm.targetType)
        )
    });
    const words: CarryWords = {
        alarmTitle: t("notices.alarm", { name: alarm.name }).slice(0, 200),
        alarmBody: reading,
        recoveredTitle: t("notices.recovered", { name: alarm.name }).slice(0, 200),
        recoveredBody: reading
    };
    return {
        words,
        delivery: {
            alarm: deliveryFromRule(firedRule, messaging),
            recovered: deliveryFromRule(clearedRule, messaging)
        }
    };
}

/** Alarms this build could not carry, said once per process rather than every boot. */
const reported = new Set<string>();

/** Carry one alarm; the automation's id, or null when it stays on Watch. */
async function carryOne(alarm: CarriableAlarm): Promise<string | null> {
    if (!carrySource(alarm) || alarm.threshold === null) return null;
    const { words, delivery } = await carryInputs(alarm);
    const converted = watchAlarmGraph(alarm, words, delivery);
    if (!converted.ok) return null;
    const { importAutomation } = await import("@/lib/automations/app-bridge");
    const automationId = await importAutomation({
        legacyRef: `${WATCH_ALARM_PREFIX}${alarm.id}`,
        name: alarm.name.slice(0, 200),
        enabled: true,
        ownerId: alarm.ownerId,
        origin: null,
        originRef: null,
        // An alarm fires once per crossing; two crossings never overlap.
        mode: "single",
        graph: converted.graph
    });
    await prisma.alarm.updateMany({
        where: { id: alarm.id, carriedToId: null },
        data: { carriedToId: automationId }
    });
    return automationId;
}

/**
 * Carry every enabled alarm that has a threshold and has not been carried yet.
 * Returns how many were carried this pass. Never throws: an alarm that cannot
 * go yet keeps running on Watch and is tried again on the next boot.
 */
export async function carryWatchAlarms(): Promise<number> {
    let carried = 0;
    let after: string | null = null;
    for (;;) {
        const rows: CarriableAlarm[] = await prisma.alarm.findMany({
            where: {
                enabled: true,
                carriedToId: null,
                metric: { in: [...SAMPLED] },
                threshold: { not: null },
                ...(after ? { id: { gt: after } } : {})
            },
            orderBy: { id: "asc" },
            take: BATCH,
            select: {
                id: true,
                ownerId: true,
                name: true,
                targetType: true,
                targetId: true,
                metric: true,
                operator: true,
                threshold: true,
                forPeriods: true,
                notifyChannelId: true,
                notifyPeerId: true
            }
        });
        for (const alarm of rows) {
            try {
                if (await carryOne(alarm)) carried += 1;
            } catch (error) {
                if (!reported.has(alarm.id)) {
                    reported.add(alarm.id);
                    console.error(`polaris: Watch alarm ${alarm.id} stays on Watch for now:`, error);
                }
            }
        }
        if (rows.length < BATCH) break;
        after = rows.at(-1)!.id;
    }
    return carried;
}
