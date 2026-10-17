/**
 * The `automations` scheduled pass, every few seconds: fire due schedules,
 * match the outbox, finish due waits, step the runs nobody is stepping (a dead
 * process's included, once its lease expires), and now and then prune.
 *
 * Admission (schedules and the outbox) runs under the intake lease; stepping
 * is claimed run by run, at most `PARALLEL_RUNS` at once in this process.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { withLease } from "@/lib/cron/lease";
import { fireDueSchedules } from "./triggers";
import { noteEngineBoot } from "./legacy-retirement";
import { INTAKE_LEASE, processAutomationEvents } from "./outbox";
import { advanceRun, resumeDueWaits, resumeEndedCalls, runnableRuns, stopClaiming } from "./engine";

const L = core.AUTOMATION_LIMITS;
const PARALLEL_RUNS = 8;
const PRUNE_EVERY_MS = 10 * 60_000;
const DAY = 24 * 60 * 60 * 1000;

let lastPrune = 0;
let signalled = false;

export async function runAutomationsPass(): Promise<Record<string, number>> {
    if (!signalled) {
        signalled = true;
        // An Update stops this container: stop claiming, let in-flight steps finish.
        process.once("SIGTERM", stopClaiming);
    }
    await noteEngineBoot();
    const intake = await withLease(INTAKE_LEASE, 2 * 60_000, async () => {
        const scheduled = await fireDueSchedules();
        const matched = await processAutomationEvents();
        return scheduled.length + matched.length;
    });
    const resumed = [...(await resumeDueWaits()), ...(await resumeEndedCalls())];
    const runs = [...new Set([...resumed, ...(await runnableRuns(PARALLEL_RUNS))])].slice(
        0,
        PARALLEL_RUNS
    );
    await Promise.all(
        runs.map((id) =>
            advanceRun(id).catch((caught) =>
                console.error("polaris: an automation run failed to step:", caught)
            )
        )
    );
    let pruned = 0;
    if (Date.now() - lastPrune >= PRUNE_EVERY_MS) {
        lastPrune = Date.now();
        pruned = await pruneAutomationHistory();
    }
    return { started: intake ?? 0, resumed: resumed.length, stepped: runs.length, pruned };
}

/** Runs that were turned away at the door: they never ran, so only the newest few are worth keeping. */
const TURNED_AWAY = ["limited", "skipped", "refused"];
const PRUNE_BATCH = 50;
let pruneCursor: string | undefined;

/** Finished runs matching `where` past the newest `keep`, and older than `floor` when one is given. */
async function pruneRuns(
    automationId: string,
    where: Record<string, unknown>,
    keep: number,
    floor: Date | null
): Promise<number> {
    const keepFrom = await prisma.automationRun.findMany({
        where: { automationId, ...where },
        orderBy: { queuedAt: "desc" },
        skip: keep - 1,
        take: 1,
        select: { queuedAt: true }
    });
    if (keepFrom.length === 0) return 0;
    const before = floor
        ? new Date(Math.min(keepFrom[0]!.queuedAt.getTime(), floor.getTime()))
        : keepFrom[0]!.queuedAt;
    const gone = await prisma.automationRun.deleteMany({
        where: { automationId, ...where, finishedAt: { not: null }, queuedAt: { lt: before } }
    });
    return gone.count;
}

/**
 * Keep 100 runs per automation and 30 days, whichever keeps more; runs turned
 * away (rate limited, skipped, refused) and test runs only by count, 100 and
 * 20. Processed events for 7 days. Bounded per pass: a batch of automations,
 * the next batch on the next pass, so every automation is reached in turn.
 */
export async function pruneAutomationHistory(): Promise<number> {
    const now = Date.now();
    const cutoff = new Date(now - L.keepRunsDays * DAY);
    let removed = 0;
    const batch = await prisma.automation.findMany({
        where: pruneCursor ? { id: { gt: pruneCursor } } : {},
        orderBy: { id: "asc" },
        select: { id: true },
        take: PRUNE_BATCH
    });
    pruneCursor = batch.length === PRUNE_BATCH ? batch[batch.length - 1]!.id : undefined;
    for (const { id: automationId } of batch) {
        removed += await pruneRuns(
            automationId,
            { test: false, status: { in: TURNED_AWAY } },
            L.keepRuns,
            null
        );
        removed += await pruneRuns(
            automationId,
            { test: false, status: { notIn: TURNED_AWAY } },
            L.keepRuns,
            cutoff
        );
        removed += await pruneRuns(automationId, { test: true }, L.keepTestRuns, null);
    }
    const events = await prisma.automationEvent.deleteMany({
        where: { processedAt: { lt: new Date(now - L.eventKeepDays * DAY) } }
    });
    return removed + events.count;
}
