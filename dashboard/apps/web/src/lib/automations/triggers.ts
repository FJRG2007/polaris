/**
 * Arming triggers: the `AutomationTrigger` rows a published version needs, and
 * the clock that fires the due ones.
 *
 * Rows are derived on publish so an event finds the automations it starts by
 * index. Re-publishing keeps a schedule's next due time when its config did not
 * change, so a publish never makes a schedule fire early or skip.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { loadEnv } from "@polaris/config";
import { createHash, createHmac } from "node:crypto";
import type { StartedRun } from "./engine";
import { fireTrigger } from "./combine";
import { closeStrandedEpisodes } from "./alarm-episodes";

/** The secret part of a webhook trigger's address. Derived, never stored; only its hash is. */
export function hookToken(automationId: string, nodeId: string, rotation: number): string {
    return createHmac("sha256", loadEnv().POLARIS_MASTER_KEY)
        .update(`automation-hook:${automationId}:${nodeId}:${rotation}`)
        .digest("base64url");
}

export function hookHash(token: string): string {
    return createHash("sha256").update(token).digest("hex");
}

export function hookPath(automationId: string, nodeId: string, rotation: number): string {
    return `/api/automations/hooks/${hookToken(automationId, nodeId, rotation)}`;
}

export function manualSubject(automationId: string, nodeId: string): string {
    return `${automationId}:${nodeId}`;
}

interface Armed {
    nodeId: string;
    eventType: string;
    subjectKey: string | null;
    hookHash: string | null;
    nextDueAt: Date | null;
    state: { config: string } & Record<string, unknown>;
}

/** The rows a graph's triggers arm, given the ones already there. Pure apart from the clock. */
export function armedTriggers(
    automationId: string,
    graph: core.AutomationGraph,
    existing: readonly { nodeId: string; nextDueAt: Date | null; state: unknown }[],
    now: Date
): Armed[] {
    const out: Armed[] = [];
    for (const node of core.triggerNodes(graph)) {
        if (node.enabled === false) continue;
        const configKey = JSON.stringify(node.config ?? {});
        if (node.type === "core.manual") {
            out.push({
                nodeId: node.id,
                eventType: "core.manual",
                subjectKey: manualSubject(automationId, node.id),
                hookHash: null,
                nextDueAt: null,
                state: { config: configKey }
            });
        } else if (node.type === "core.webhook") {
            const config = core.CORE_NODE_CONFIGS["core.webhook"].parse(node.config);
            const hash = hookHash(hookToken(automationId, node.id, config.rotation));
            out.push({
                nodeId: node.id,
                eventType: "core.webhook",
                subjectKey: hash,
                hookHash: hash,
                nextDueAt: null,
                state: { config: configKey }
            });
        } else if (node.type === "core.onEvent") {
            const config = core.CORE_NODE_CONFIGS["core.onEvent"].safeParse(node.config);
            if (!config.success) continue;
            out.push({
                nodeId: node.id,
                eventType: "core.event",
                subjectKey: config.data.name,
                hookHash: null,
                nextDueAt: null,
                state: { config: configKey }
            });
        } else if (node.type === "core.failed") {
            out.push({
                nodeId: node.id,
                eventType: "core.failed",
                subjectKey: null,
                hookHash: null,
                nextDueAt: null,
                state: { config: configKey }
            });
        } else if (core.appNodeRole(node.type) === "trigger") {
            // An app's trigger: the app reads these rows and decides when one
            // fires (app-bridge.ts). Kept while the app is away, never read then.
            out.push({
                nodeId: node.id,
                eventType: node.type,
                subjectKey: null,
                hookHash: null,
                nextDueAt: null,
                state: { config: configKey }
            });
        } else if (node.type === "core.connectivity") {
            // Fired by the connectivity sampler's events (lib/connectivity/line-events.ts),
            // matched by the event it names.
            const config = core.connectivityTriggerConfigSchema.safeParse(node.config);
            if (!config.success) continue;
            out.push({
                nodeId: node.id,
                eventType: "core.connectivity",
                subjectKey: config.data.event,
                hookHash: null,
                nextDueAt: null,
                state: { config: configKey }
            });
        } else if (node.type === "core.threshold") {
            // Polled (thresholds.ts). Its memory - ok or alarm, the streak, the
            // open episode - survives a publish that left its config alone.
            const config = core.thresholdConfigSchema.safeParse(node.config);
            if (!config.success) continue;
            const before = existing.find((row) => row.nodeId === node.id);
            const kept = before?.state as ({ config?: string } & Record<string, unknown>) | null;
            const same = kept?.config === configKey;
            out.push({
                nodeId: node.id,
                eventType: "core.threshold",
                subjectKey: `${config.data.source}:${config.data.subjectId}`,
                hookHash: null,
                nextDueAt: same && before?.nextDueAt ? before.nextDueAt : now,
                state: same && kept ? { ...kept, config: configKey } : { config: configKey }
            });
        } else if (node.type === "core.schedule") {
            const config = core.scheduleConfigSchema.parse(node.config);
            const before = existing.find((row) => row.nodeId === node.id);
            const same = (before?.state as { config?: string } | null)?.config === configKey;
            const nextDueAt =
                same && before?.nextDueAt
                    ? before.nextDueAt
                    : core.nextScheduleDue(config, now, graph.timeZone);
            out.push({
                nodeId: node.id,
                eventType: "core.schedule",
                subjectKey: null,
                hookHash: null,
                nextDueAt,
                state: { config: configKey }
            });
        }
    }
    return out;
}

/** Arm a version's triggers, removing the ones it no longer has. */
export async function armVersion(
    automationId: string,
    versionId: string,
    graph: core.AutomationGraph
): Promise<void> {
    const existing = await prisma.automationTrigger.findMany({
        where: { automationId },
        select: { nodeId: true, nextDueAt: true, state: true },
        take: core.AUTOMATION_LIMITS.nodes
    });
    const armed = armedTriggers(automationId, graph, existing, new Date());
    await prisma.automationTrigger.deleteMany({
        where: { automationId, nodeId: { notIn: armed.map((row) => row.nodeId) } }
    });
    for (const row of armed) {
        const data = {
            versionId,
            eventType: row.eventType,
            subjectKey: row.subjectKey,
            hookHash: row.hookHash,
            nextDueAt: row.nextDueAt,
            state: row.state as object
        };
        await prisma.automationTrigger.upsert({
            where: { automationId_nodeId: { automationId, nodeId: row.nodeId } },
            create: { automationId, nodeId: row.nodeId, ...data },
            update: data
        });
    }
    await closeStrandedEpisodes(automationId, openEpisodes(armed));
}

/** The alarm episodes armed threshold triggers still hold open in their memory. */
function openEpisodes(
    armed: readonly { nodeId: string; eventType: string; state: Record<string, unknown> }[]
): { nodeId: string; startedAt: string }[] {
    return armed.flatMap((row) => {
        const episode = row.state.episode as { startedAt?: unknown } | null | undefined;
        return row.eventType === "core.threshold" && typeof episode?.startedAt === "string"
            ? [{ nodeId: row.nodeId, startedAt: episode.startedAt }]
            : [];
    });
}

export async function disarm(automationId: string): Promise<void> {
    await prisma.automationTrigger.deleteMany({ where: { automationId } });
    await closeStrandedEpisodes(automationId, []);
}

/**
 * Fire every schedule that is due. The due time is moved on by compare-and-swap
 * first, so two processes fire one run; the firing key carries the due time, so
 * a pass that crashed after moving it and is re-run never doubles it. An
 * occurrence missed by more than the catch-up window (Polaris was down) is
 * skipped rather than fired late.
 */
export async function fireDueSchedules(limit = 100): Promise<StartedRun[]> {
    const now = new Date();
    const due = await prisma.automationTrigger.findMany({
        where: { eventType: "core.schedule", nextDueAt: { lte: now } },
        orderBy: { nextDueAt: "asc" },
        take: limit,
        select: { id: true, automationId: true, versionId: true, nodeId: true, nextDueAt: true }
    });
    const started: StartedRun[] = [];
    for (const row of due) {
        const graph = await prisma.automationVersion.findUnique({
            where: { id: row.versionId },
            select: { graph: true }
        });
        const parsed = core.automationGraphSchema.safeParse(graph?.graph);
        const node = parsed.success
            ? parsed.data.nodes.find((entry) => entry.id === row.nodeId)
            : undefined;
        const config = node ? core.scheduleConfigSchema.safeParse(node.config) : null;
        const dueAt = row.nextDueAt!;
        const next =
            parsed.success && config?.success
                ? core.nextScheduleDue(
                      config.data,
                      new Date(Math.max(now.getTime(), dueAt.getTime())),
                      parsed.data.timeZone
                  )
                : null;
        const moved = await prisma.automationTrigger.updateMany({
            where: { id: row.id, nextDueAt: dueAt },
            data: { nextDueAt: next }
        });
        if (moved.count !== 1) continue;
        if (now.getTime() - dueAt.getTime() > core.AUTOMATION_LIMITS.catchUpMs) continue;
        const run = await fireTrigger({
            automationId: row.automationId,
            versionId: row.versionId,
            triggerNodeId: row.nodeId,
            firingKey: `${row.nodeId}:${dueAt.toISOString()}`,
            cause: { id: row.nodeId, at: dueAt.toISOString(), kind: "schedule" },
            depth: 0
        });
        if (run) started.push(run);
    }
    return started;
}
