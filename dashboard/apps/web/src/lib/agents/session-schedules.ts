/**
 * Code sessions a repository starts on its own, on a cron schedule.
 *
 * Modelled on scheduled jobs (`lib/deploy/service-cron.ts`): the instance's own
 * scheduler ticks every minute, and each firing is claimed with a
 * compare-and-swap on the schedule's `nextRunAt` before anything is started, so
 * two dashboard processes reading the same row start it once between them. The
 * claim moves `nextRunAt` to the next firing after now, not after the missed
 * one, so a schedule that came due several times while Polaris was down starts
 * one session when it is back, not one per missed firing.
 *
 * The session starts as the person who saved the schedule, through the same
 * admission every other start uses (`session-queue.admitSession`), so a
 * schedule cannot start past the ceilings that person is held to: over one, the
 * session queues. A firing that arrives while the last session it started is
 * still going is skipped and says so, rather than piling up copies.
 *
 * Server-only.
 */

export * from "@/lib/agents/session-schedule-input";

import {
    SESSION_SCHEDULE_RUN_STATUSES,
    SESSION_SCHEDULES_PER_REPO,
    type SessionScheduleInput,
    type SessionScheduleRunStatus,
    type SessionScheduleView
} from "@/lib/agents/session-schedule-input";
import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import * as queue from "@/lib/agents/session-queue";
import * as runtime from "@/lib/agents/session-runtime";
import * as sessions from "@/lib/agents/session-service";

/** How many firings of one schedule are kept; older ones go as new ones arrive. */
const KEPT_RUNS = 30;

/** The states of a session still doing what the last firing asked. */
const BUSY_STATES: ReadonlySet<string> = new Set(["queued", "starting", "working", "waiting"]);

/** How many due schedules one tick reads. The rest are due on the next tick. */
const TICK_TAKE = 100;

/** When a schedule next fires after `after`, or null when it is off or never fires. */
export function nextFiring(schedule: string, timezone: string, enabled: boolean, after = new Date()): Date | null {
    if (!enabled) return null;
    return core.nextCronRun(core.parseCron(schedule), after, timezone);
}

const VIEW_SELECT = {
    id: true,
    cli: true,
    schedule: true,
    timezone: true,
    prompt: true,
    enabled: true,
    nextRunAt: true,
    lastRunAt: true,
    runs: {
        orderBy: { createdAt: "desc" },
        take: 5,
        select: { id: true, status: true, sessionId: true, error: true, createdAt: true }
    }
} as const;

type ViewRow = {
    id: string;
    cli: string;
    schedule: string;
    timezone: string;
    prompt: string;
    enabled: boolean;
    nextRunAt: Date | null;
    lastRunAt: Date | null;
    runs: { id: string; status: string; sessionId: string | null; error: string | null; createdAt: Date }[];
};

function toView(row: ViewRow): SessionScheduleView {
    return {
        id: row.id,
        cli: row.cli,
        schedule: row.schedule,
        scheduleText: core.describeCron(row.schedule),
        timezone: row.timezone,
        prompt: row.prompt,
        enabled: row.enabled,
        nextRunAt: row.nextRunAt?.toISOString() ?? null,
        lastRunAt: row.lastRunAt?.toISOString() ?? null,
        runs: row.runs.map((run) => ({
            id: run.id,
            status: (SESSION_SCHEDULE_RUN_STATUSES as readonly string[]).includes(run.status)
                ? (run.status as SessionScheduleRunStatus)
                : "failed",
            sessionId: run.sessionId,
            error: run.error,
            at: run.createdAt.toISOString()
        }))
    };
}

/** A repository's schedules. The caller has authorized the repository. */
export async function listSessionSchedules(repoId: string): Promise<SessionScheduleView[]> {
    const rows = await prisma.agentSessionSchedule.findMany({
        where: { repoId },
        orderBy: { createdAt: "asc" },
        take: SESSION_SCHEDULES_PER_REPO,
        select: VIEW_SELECT
    });
    return rows.map(toView);
}

/** Why a save was refused, as a code the screen words itself. */
export type ScheduleRefusal = "notFound" | "tooMany";

/** Create a schedule, or change one of this repository's. The caller has authorized the repository. */
export async function saveSessionSchedule(
    input: SessionScheduleInput,
    userId: string,
    now = new Date()
): Promise<{ view: SessionScheduleView } | { refusal: ScheduleRefusal }> {
    const data = {
        cli: input.cli,
        schedule: input.schedule,
        timezone: input.timezone,
        prompt: input.prompt,
        enabled: input.enabled,
        nextRunAt: nextFiring(input.schedule, input.timezone, input.enabled, now)
    };
    if (input.id) {
        const changed = await prisma.agentSessionSchedule.updateMany({
            where: { id: input.id, repoId: input.repoId },
            data
        });
        if (changed.count === 0) return { refusal: "notFound" };
        const row = await prisma.agentSessionSchedule.findUniqueOrThrow({ where: { id: input.id }, select: VIEW_SELECT });
        return { view: toView(row) };
    }
    const held = await prisma.agentSessionSchedule.count({ where: { repoId: input.repoId } });
    if (held >= SESSION_SCHEDULES_PER_REPO) return { refusal: "tooMany" };
    const row = await prisma.agentSessionSchedule.create({
        data: { ...data, repoId: input.repoId, createdById: userId },
        select: VIEW_SELECT
    });
    return { view: toView(row) };
}

/** Switch one of this repository's schedules on or off. False when it is not this repository's. */
export async function setSessionScheduleEnabled(
    repoId: string,
    id: string,
    enabled: boolean,
    now = new Date()
): Promise<boolean> {
    const row = await prisma.agentSessionSchedule.findFirst({
        where: { id, repoId },
        select: { schedule: true, timezone: true }
    });
    if (!row) return false;
    await prisma.agentSessionSchedule.update({
        where: { id },
        data: { enabled, nextRunAt: nextFiring(row.schedule, row.timezone, enabled, now) }
    });
    return true;
}

/** Remove one of this repository's schedules and its history. False when it is not this repository's. */
export async function deleteSessionSchedule(repoId: string, id: string): Promise<boolean> {
    const removed = await prisma.agentSessionSchedule.deleteMany({ where: { id, repoId } });
    return removed.count > 0;
}

/**
 * The scheduler's minute: start every schedule that is due.
 *
 * Each is claimed before it is started - `nextRunAt` is moved on only where it
 * still holds the value this pass read - so a second process reading the same
 * row a moment later finds nothing left to claim.
 */
export async function tickSessionSchedules(
    now = new Date()
): Promise<{ started: number; skipped: number; failed: number }> {
    const counts = { started: 0, skipped: 0, failed: 0 };
    const due = await prisma.agentSessionSchedule.findMany({
        // A repository switched off starts nothing; its schedules wait for it.
        where: { enabled: true, nextRunAt: { lte: now }, repo: { enabled: true } },
        orderBy: { nextRunAt: "asc" },
        take: TICK_TAKE,
        select: {
            id: true,
            repoId: true,
            createdById: true,
            cli: true,
            schedule: true,
            timezone: true,
            prompt: true,
            nextRunAt: true,
            lastSessionId: true,
            repo: { select: { repoFullName: true } }
        }
    });
    for (const row of due) {
        let next: Date | null;
        try {
            // From now, not from the firing that was due: every firing missed
            // while nothing ticked collapses into this one.
            next = nextFiring(row.schedule, row.timezone, true, now);
        } catch {
            // A schedule that no longer parses is switched off rather than
            // re-read and refused every minute.
            await prisma.agentSessionSchedule.update({
                where: { id: row.id },
                data: { enabled: false, nextRunAt: null }
            });
            continue;
        }
        const claimed = await prisma.agentSessionSchedule.updateMany({
            where: { id: row.id, nextRunAt: row.nextRunAt },
            data: { nextRunAt: next, lastRunAt: now }
        });
        if (claimed.count === 0) continue;
        const outcome = await fire(row);
        counts[outcome === "queued" ? "started" : outcome] += 1;
        await pruneRuns(row.id);
    }
    return counts;
}

/** Start one claimed firing and record what came of it. */
async function fire(row: {
    id: string;
    repoId: string;
    createdById: string;
    cli: string;
    prompt: string;
    lastSessionId: string | null;
    repo: { repoFullName: string };
}): Promise<SessionScheduleRunStatus> {
    const record = async (status: SessionScheduleRunStatus, sessionId: string | null, error: string | null) => {
        await prisma.agentSessionScheduleRun.create({ data: { scheduleId: row.id, status, sessionId, error } });
        await prisma.agentSessionSchedule.update({
            where: { id: row.id },
            data: { lastError: error, ...(sessionId ? { lastSessionId: sessionId } : {}) }
        });
        return status;
    };
    if (row.lastSessionId) {
        const last = await prisma.agentSession.findUnique({
            where: { id: row.lastSessionId },
            select: { state: true }
        });
        // An idle session finished its turn: the work is done, and admission
        // stops idle sessions first when a slot is needed.
        if (last && BUSY_STATES.has(last.state)) {
            // i18n-ignore stored with the firing, so written once in the default language
            return record("skipped", null, "The session the last firing started was still going.");
        }
    }
    try {
        const admission = await queue.admitSession(
            {
                repoId: row.repoId,
                startedById: row.createdById,
                title: titleOf(row.prompt),
                cli: row.cli,
                command: null,
                // A scheduled session runs where a session started by a model
                // runs: in a container on the Polaris box, with whichever
                // credential resolves. Nobody is there to choose otherwise.
                place: "local",
                sharedHome: false,
                unattended: null,
                accountId: null,
                useMachineLogin: false,
                modelChoice: null,
                hostId: null,
                baseRef: "",
                taskId: null,
                enigma: null
            },
            row.prompt
        );
        if (admission.startError) {
            return record(
                "failed",
                admission.session.id,
                sessions.readableFailure(admission.startError, `starting scheduled ${admission.session.id}`)
            );
        }
        if (admission.queuedAt !== null) return record("queued", admission.session.id, null);
        // No request to wait for here: the delivery waits for the agent's
        // terminal on its own and records what happened on the session.
        void runtime.deliverFirstPrompt(admission.session.id, row.prompt).catch(() => undefined);
        return record("started", admission.session.id, null);
    } catch (error) {
        const shown =
            error instanceof sessions.SessionRefusal
                ? error.message
                : sessions.readableFailure(error, `a scheduled session on ${row.repo.repoFullName}`);
        return record("failed", null, shown);
    }
}

/** The prompt's first line, as the session's title. */
function titleOf(prompt: string): string {
    const first = prompt.split(/\r?\n/, 1)[0]?.trim() ?? "";
    return first.length > 80 ? `${first.slice(0, 79)}...` : first || "Scheduled session";
}

/** Keep the newest firings of a schedule and drop the rest. */
async function pruneRuns(scheduleId: string): Promise<void> {
    const stale = await prisma.agentSessionScheduleRun.findMany({
        where: { scheduleId },
        orderBy: { createdAt: "desc" },
        skip: KEPT_RUNS,
        select: { id: true }
    });
    if (stale.length > 0)
        await prisma.agentSessionScheduleRun.deleteMany({ where: { id: { in: stale.map((run) => run.id) } } });
}
