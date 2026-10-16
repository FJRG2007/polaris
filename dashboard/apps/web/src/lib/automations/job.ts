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
import { advanceRun, resumeDueWaits, runnableRuns, stopClaiming } from "./engine";

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
    const resumed = await resumeDueWaits();
    const runs = [...new Set([...resumed, ...(await runnableRuns(PARALLEL_RUNS))])].slice(0, PARALLEL_RUNS);
    await Promise.all(runs.map((id) => advanceRun(id).catch((caught) => console.error("polaris: an automation run failed to step:", caught))));
    let pruned = 0;
    if (Date.now() - lastPrune >= PRUNE_EVERY_MS) {
        lastPrune = Date.now();
        pruned = await pruneAutomationHistory();
    }
    return { started: intake ?? 0, resumed: resumed.length, stepped: runs.length, pruned };
}

/**
 * Keep 100 runs per automation and 30 days, whichever keeps more (test runs:
 * 20), and processed events for 7 days. Bounded per pass.
 */
export async function pruneAutomationHistory(): Promise<number> {
    const now = Date.now();
    const cutoff = new Date(now - L.keepRunsDays * DAY);
    let removed = 0;
    const old = await prisma.automationRun.findMany({
        where: { finishedAt: { lt: cutoff } },
        distinct: ["automationId"],
        select: { automationId: true },
        take: 50
    });
    for (const { automationId } of old) {
        const keepFrom = await prisma.automationRun.findMany({
            where: { automationId, test: false },
            orderBy: { queuedAt: "desc" },
            skip: L.keepRuns - 1,
            take: 1,
            select: { queuedAt: true }
        });
        if (keepFrom.length === 0) continue;
        const before = new Date(Math.min(keepFrom[0]!.queuedAt.getTime(), cutoff.getTime()));
        const gone = await prisma.automationRun.deleteMany({
            where: { automationId, test: false, finishedAt: { not: null }, queuedAt: { lt: before } }
        });
        removed += gone.count;
    }
    const events = await prisma.automationEvent.deleteMany({
        where: { processedAt: { lt: new Date(now - L.eventKeepDays * DAY) } }
    });
    return removed + events.count;
}
