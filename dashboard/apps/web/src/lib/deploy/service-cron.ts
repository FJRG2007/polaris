/**
 * Scheduled jobs for deployed services.
 *
 * A job is a command a service runs on a cron schedule inside its own running
 * container - its code, its variables, its network - the way a crontab line runs
 * on a server. Nothing is built or deployed for it, which is why it is instant to
 * set up and why it needs the service to be running: a job for a service that is
 * down is recorded as failed, saying so, rather than silently skipped.
 *
 * The scheduler is the instance's own (`lib/cron`), ticking every minute. Each
 * firing is claimed with a compare-and-swap on the job's `nextRunAt`, so two
 * Polaris processes during a rollover cannot both run the same minute; a firing
 * that arrives while the previous run is still going is skipped and says so in
 * the run list, rather than piling up copies of a slow job.
 *
 * A run is bounded twice: the command is wrapped in `timeout` inside the
 * container where the image has one, and the wait here gives up a little after
 * that regardless, so a container that never answers cannot hold a job forever.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { currentReleaseRef } from "./releases";
import { notify } from "../notifications/dispatch";
import { getPorts, type TargetRow } from "./runtime";

/** The end of the output kept per run. The end of a log is where the reason is. */
export const CRON_OUTPUT_LIMIT = 64 * 1024;

/** How many runs of one job are kept; older ones go as new ones arrive. */
const KEPT_RUNS = 100;

/** Seconds past the job's own timeout before the wait here gives up. */
const GRACE_SECONDS = 30;

/** A job as the screen shows it. */
export interface ServiceCronView {
    readonly id: string;
    readonly name: string;
    readonly schedule: string;
    readonly scheduleText: string;
    readonly timezone: string;
    readonly command: string;
    readonly timeoutSeconds: number;
    readonly maxAttempts: number;
    readonly retryDelaySeconds: number;
    readonly enabled: boolean;
    readonly nextRunAt: string | null;
    readonly lastRunAt: string | null;
    readonly lastStatus: string | null;
}

export interface ServiceCronRunView {
    readonly id: string;
    readonly trigger: string;
    readonly attempt: number;
    readonly status: string;
    readonly exitCode: number | null;
    readonly output: string;
    readonly error: string | null;
    readonly startedAt: string;
    readonly finishedAt: string | null;
}

/** What a job is saved from, validated by the caller with `serviceCronInputSchema`. */
export type ServiceCronInput = core.ServiceCronInput;

function toView(row: {
    id: string;
    name: string;
    schedule: string;
    timezone: string;
    command: string;
    timeoutSeconds: number;
    maxAttempts: number;
    retryDelaySeconds: number;
    enabled: boolean;
    nextRunAt: Date | null;
    lastRunAt: Date | null;
    lastStatus: string | null;
}): ServiceCronView {
    return {
        id: row.id,
        name: row.name,
        schedule: row.schedule,
        scheduleText: core.describeCron(row.schedule),
        timezone: row.timezone,
        command: row.command,
        timeoutSeconds: row.timeoutSeconds,
        maxAttempts: row.maxAttempts,
        retryDelaySeconds: row.retryDelaySeconds,
        enabled: row.enabled,
        nextRunAt: row.nextRunAt?.toISOString() ?? null,
        lastRunAt: row.lastRunAt?.toISOString() ?? null,
        lastStatus: row.lastStatus
    };
}

/** When a job next fires from now, or null when it is off or never fires. */
function nextFiring(
    schedule: string,
    timezone: string,
    enabled: boolean,
    after = new Date()
): Date | null {
    if (!enabled) return null;
    return core.nextCronRun(core.parseCron(schedule), after, timezone);
}

/** A service's jobs. The caller has authorized the service. */
export async function listServiceCrons(applicationId: string): Promise<ServiceCronView[]> {
    const rows = await prisma.serviceCron.findMany({
        where: { applicationId },
        orderBy: { createdAt: "asc" }
    });
    return rows.map(toView);
}

/** Create a job, or change one of this service's. */
export async function saveServiceCron(
    applicationId: string,
    input: ServiceCronInput,
    userId: string
): Promise<ServiceCronView> {
    const data = {
        name: input.name,
        schedule: input.schedule,
        timezone: input.timezone,
        command: input.command,
        timeoutSeconds: input.timeoutSeconds,
        maxAttempts: input.maxAttempts,
        retryDelaySeconds: input.retryDelaySeconds,
        enabled: input.enabled,
        nextRunAt: nextFiring(input.schedule, input.timezone, input.enabled),
        // A changed schedule starts afresh: a retry owed to the old command is
        // not owed to the new one.
        retryAt: null,
        retryAttempt: 0
    };
    if (input.id) {
        const existing = await prisma.serviceCron.findFirst({
            where: { id: input.id, applicationId },
            select: { id: true }
        });
        if (!existing) throw new Error("Scheduled job not found");
        return toView(await prisma.serviceCron.update({ where: { id: input.id }, data }));
    }
    return toView(
        await prisma.serviceCron.create({ data: { ...data, applicationId, createdById: userId } })
    );
}

/** Remove one of this service's jobs and its run history. */
export async function deleteServiceCron(applicationId: string, cronId: string): Promise<void> {
    const removed = await prisma.serviceCron.deleteMany({ where: { id: cronId, applicationId } });
    if (removed.count === 0) throw new Error("Scheduled job not found");
}

/** A job's recent runs, newest first. */
export async function listServiceCronRuns(
    applicationId: string,
    cronId: string
): Promise<ServiceCronRunView[]> {
    const rows = await prisma.serviceCronRun.findMany({
        where: { cronId, cron: { applicationId } },
        orderBy: { startedAt: "desc" },
        take: 30
    });
    return rows.map((row) => ({
        id: row.id,
        trigger: row.trigger,
        attempt: row.attempt,
        status: row.status,
        exitCode: row.exitCode,
        output: row.output,
        error: row.error,
        startedAt: row.startedAt.toISOString(),
        finishedAt: row.finishedAt?.toISOString() ?? null
    }));
}

/** Run one of this service's jobs now, whatever its schedule. Answers the run. */
export async function runServiceCronNow(applicationId: string, cronId: string): Promise<string> {
    const cron = await prisma.serviceCron.findFirst({
        where: { id: cronId, applicationId },
        select: { id: true }
    });
    if (!cron) throw new Error("Scheduled job not found");
    return startRun(cronId, "manual", 1);
}

/**
 * The scheduler's minute: start every job whose firing or retry is due.
 *
 * Each is claimed before it is started - `nextRunAt` (or `retryAt`) is moved on
 * only where it still holds the value this pass read - so a second process
 * reading the same row a moment later finds nothing left to claim.
 */
export async function tickServiceCrons(
    now = new Date()
): Promise<{ started: number; skipped: number }> {
    let started = 0;
    let skipped = 0;
    const due = await prisma.serviceCron.findMany({
        where: {
            OR: [
                { enabled: true, nextRunAt: { lte: now } },
                { enabled: true, retryAt: { lte: now } }
            ]
        },
        select: {
            id: true,
            schedule: true,
            timezone: true,
            nextRunAt: true,
            retryAt: true,
            retryAttempt: true,
            timeoutSeconds: true
        },
        take: 200
    });
    for (const cron of due) {
        const retrying = cron.retryAt !== null && cron.retryAt <= now;
        if (retrying) {
            const claimed = await prisma.serviceCron.updateMany({
                where: { id: cron.id, retryAt: cron.retryAt },
                data: { retryAt: null }
            });
            if (claimed.count === 0) continue;
        } else {
            let next: Date | null = null;
            try {
                next = nextFiring(cron.schedule, cron.timezone, true, now);
            } catch {
                // A schedule that no longer parses is switched off rather than
                // re-read and refused every minute.
                await prisma.serviceCron.update({
                    where: { id: cron.id },
                    data: { enabled: false, nextRunAt: null }
                });
                continue;
            }
            const claimed = await prisma.serviceCron.updateMany({
                where: { id: cron.id, nextRunAt: cron.nextRunAt },
                data: { nextRunAt: next }
            });
            if (claimed.count === 0) continue;
        }
        // Still running from the last firing: this one is skipped, and recorded
        // as skipped, rather than a second copy started beside it.
        const busy = await prisma.serviceCronRun.findFirst({
            where: {
                cronId: cron.id,
                status: "running",
                startedAt: {
                    gt: new Date(now.getTime() - (cron.timeoutSeconds + GRACE_SECONDS) * 1000)
                }
            },
            select: { id: true }
        });
        if (busy) {
            await prisma.serviceCronRun.create({
                data: {
                    cronId: cron.id,
                    trigger: retrying ? "retry" : "schedule",
                    status: "skipped",
                    error: "The previous run was still going.",
                    finishedAt: now
                }
            });
            skipped += 1;
            continue;
        }
        await startRun(cron.id, retrying ? "retry" : "schedule", retrying ? cron.retryAttempt : 1);
        started += 1;
    }
    return { started, skipped };
}

/** Record a run and start it in the background. Answers its id. */
async function startRun(
    cronId: string,
    trigger: "schedule" | "manual" | "retry",
    attempt: number
): Promise<string> {
    const run = await prisma.serviceCronRun.create({
        data: { cronId, trigger, attempt, status: "running" }
    });
    void execute(run.id).catch((error: unknown) => {
        console.error("polaris: a scheduled job could not be run:", error);
    });
    return run.id;
}

/** The wrapper the command runs in: `timeout` where the image has one, so the
 *  command stops inside the container when its time is up. Positional arguments,
 *  never interpolated, so the command reaches `sh -c` exactly as it was written. */
const WRAPPER =
    'if command -v timeout >/dev/null 2>&1; then exec timeout "$2" sh -c "$1"; else exec sh -c "$1"; fi';

async function execute(runId: string): Promise<void> {
    const run = await prisma.serviceCronRun.findUnique({
        where: { id: runId },
        include: {
            cron: {
                include: {
                    application: {
                        include: {
                            target: true,
                            environment: {
                                select: {
                                    project: {
                                        select: { id: true, name: true, slug: true, ownerId: true }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    });
    if (!run) return;
    const { cron } = run;
    const app = cron.application;
    const ownerId = app.environment.project.ownerId;

    let status: "succeeded" | "failed" | "timed_out" = "failed";
    let exitCode: number | null = null;
    let output = "";
    let error: string | null = null;

    if (!app.currentDeploymentId || app.desiredState !== "running") {
        error = "The service is not running, so there was nothing to run the command in.";
    } else {
        const release = await currentReleaseRef(app);
        const ports = await getPorts(app.target as TargetRow, ownerId).catch(() => null);
        if (!ports) {
            error = "The server the service runs on could not be reached.";
        } else {
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
                const outcome = await Promise.race([
                    ports.runIn(release.name, [
                        "sh",
                        "-c",
                        WRAPPER,
                        "polaris",
                        cron.command,
                        String(cron.timeoutSeconds)
                    ]),
                    new Promise<"timeout">((resolve) => {
                        timer = setTimeout(
                            () => resolve("timeout"),
                            (cron.timeoutSeconds + GRACE_SECONDS) * 1000
                        );
                    })
                ]);
                if (outcome === "timeout") {
                    status = "timed_out";
                    error = `Stopped after ${cron.timeoutSeconds} seconds.`;
                } else {
                    exitCode = outcome.code;
                    output = outcome.output.slice(-CRON_OUTPUT_LIMIT);
                    // 124 is what `timeout` exits with when it had to stop the command.
                    status =
                        outcome.code === 0
                            ? "succeeded"
                            : outcome.code === 124
                              ? "timed_out"
                              : "failed";
                    if (status === "timed_out")
                        error = `Stopped after ${cron.timeoutSeconds} seconds.`;
                    else if (status === "failed") error = `Exited with code ${outcome.code}.`;
                }
            } catch (caught) {
                error =
                    caught instanceof Error ? caught.message : "The command could not be started.";
            } finally {
                if (timer) clearTimeout(timer);
                await ports.dispose().catch(() => undefined);
            }
        }
    }

    const finishedAt = new Date();
    await prisma.serviceCronRun.update({
        where: { id: runId },
        data: { status, exitCode, output, error, finishedAt }
    });

    const retry =
        status !== "succeeded" && run.attempt < cron.maxAttempts && run.trigger !== "manual";
    await prisma.serviceCron.update({
        where: { id: cron.id },
        data: {
            lastRunAt: run.startedAt,
            lastStatus: status,
            ...(retry
                ? {
                      retryAt: new Date(
                          finishedAt.getTime() + cron.retryDelaySeconds * run.attempt * 1000
                      ),
                      retryAttempt: run.attempt + 1
                  }
                : { retryAttempt: 0 })
        }
    });
    await pruneRuns(cron.id);

    // Only the last try of a scheduled run is worth a notification: an attempt
    // that will be retried may well succeed, and a manual run is being watched.
    if (status !== "succeeded" && !retry && run.trigger !== "manual") {
        const project = app.environment.project;
        await notify({
            userId: ownerId,
            event: "cron.failed",
            title: `Scheduled job failed: ${project.name} / ${app.name} / ${cron.name}`,
            body: error ?? "It did not finish.",
            href: `/apps/deploy/${project.id}?service=${app.id}`,
            actionRequired: true,
            metadata: { cronId: cron.id, runId, applicationId: app.id }
        }).catch(() => undefined);
    }
}

/** Keep the newest runs of a job and drop the rest. */
async function pruneRuns(cronId: string): Promise<void> {
    const stale = await prisma.serviceCronRun.findMany({
        where: { cronId },
        orderBy: { startedAt: "desc" },
        skip: KEPT_RUNS,
        select: { id: true }
    });
    if (stale.length > 0) {
        await prisma.serviceCronRun.deleteMany({
            where: { id: { in: stale.map((row) => row.id) } }
        });
    }
}
