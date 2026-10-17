/**
 * The outbox: how an event reaches the engine.
 *
 * `emitAutomationEvent` writes a row and returns; it never throws into the
 * caller, whose own write must not fail because of an automation. The worker
 * claims rows by conditional update, matches them against armed triggers and
 * starts runs keyed `<eventId>:<nodeId>`, so an event processed twice (a crash
 * between the match and `processedAt`) starts each run once.
 *
 * Admission is serialised across processes by the intake lease, so a "single"
 * automation started by two events at once runs once.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { withLease } from "@/lib/cron/lease";
import { advanceRun, startRun, type StartedRun } from "./engine";

const L = core.AUTOMATION_LIMITS;
const CLAIM_MS = 60_000;
export const INTAKE_LEASE = "automations-intake";
const INTAKE_LEASE_MS = 2 * 60_000;

export interface EmitInput {
    readonly orgId?: string | null;
    readonly userId?: string | null;
    readonly subjectKey?: string | null;
    readonly payload: Record<string, unknown>;
    readonly dedupeKey?: string | null;
    readonly depth?: number;
    readonly originRunId?: string | null;
}

/** Record an event for the engine. Returns its id, or null when it was a duplicate or refused. */
export async function emitAutomationEvent(type: string, input: EmitInput): Promise<string | null> {
    try {
        if (core.byteLength(JSON.stringify(input.payload)) > L.eventPayloadBytes) {
            console.warn(
                `polaris: an automation event of type ${type} was too large and was dropped`
            );
            return null;
        }
        const row = await prisma.automationEvent.create({
            data: {
                type,
                orgId: input.orgId ?? null,
                userId: input.userId ?? null,
                subjectKey: input.subjectKey ?? null,
                payload: input.payload as object,
                dedupeKey: input.dedupeKey ?? null,
                depth: input.depth ?? 0,
                originRunId: input.originRunId ?? null
            },
            select: { id: true }
        });
        return row.id;
    } catch (caught) {
        if ((caught as { code?: string } | null)?.code === "P2002") return null;
        console.error(`polaris: could not record an automation event of type ${type}:`, caught);
        return null;
    }
}

/** Match a batch of unprocessed events. Call under the intake lease. */
export async function processAutomationEvents(limit = 50): Promise<StartedRun[]> {
    const now = new Date();
    const candidates = await prisma.automationEvent.findMany({
        where: { processedAt: null, OR: [{ claimedUntil: null }, { claimedUntil: { lt: now } }] },
        orderBy: { createdAt: "asc" },
        take: limit,
        select: {
            id: true,
            type: true,
            orgId: true,
            userId: true,
            subjectKey: true,
            payload: true,
            depth: true
        }
    });
    const started: StartedRun[] = [];
    for (const event of candidates) {
        const claimed = await prisma.automationEvent.updateMany({
            where: {
                id: event.id,
                processedAt: null,
                OR: [{ claimedUntil: null }, { claimedUntil: { lt: now } }]
            },
            data: { claimedUntil: new Date(Date.now() + CLAIM_MS) }
        });
        if (claimed.count !== 1) continue;
        const triggers = await prisma.automationTrigger.findMany({
            where: { eventType: event.type, subjectKey: event.subjectKey },
            take: L.perShelf,
            select: {
                nodeId: true,
                versionId: true,
                automation: {
                    select: {
                        id: true,
                        enabled: true,
                        publishedVersionId: true,
                        orgId: true,
                        userId: true
                    }
                }
            }
        });
        for (const trigger of triggers) {
            const automation = trigger.automation;
            if (!automation.enabled || automation.publishedVersionId !== trigger.versionId)
                continue;
            // An event that names a shelf only starts that shelf's automations.
            if (event.orgId && automation.orgId !== event.orgId) continue;
            if (!event.orgId && event.userId && automation.userId !== event.userId) continue;
            const run = await startRun({
                automationId: automation.id,
                versionId: trigger.versionId,
                triggerNodeId: trigger.nodeId,
                firingKey: `${event.id}:${trigger.nodeId}`,
                cause: {
                    ...((event.payload ?? {}) as Record<string, unknown>),
                    id: trigger.nodeId,
                    at: now.toISOString()
                },
                depth: event.depth
            });
            if (run) started.push(run);
        }
        await prisma.automationEvent.update({
            where: { id: event.id },
            data: { processedAt: new Date() }
        });
    }
    return started;
}

/**
 * Process the outbox now, in this process, and start stepping what it started:
 * the latency path after an emit. If another process holds the intake lease it
 * will reach the event itself; the scheduled pass is the backstop.
 */
export async function kickIntake(): Promise<StartedRun[]> {
    const started =
        (await withLease(INTAKE_LEASE, INTAKE_LEASE_MS, () => processAutomationEvents())) ?? [];
    for (const run of started)
        if (run.status === "running")
            void advanceRun(run.id).catch((caught) =>
                console.error("polaris: an automation run failed to step:", caught)
            );
    return started;
}
