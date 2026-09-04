/**
 * The long jobs Drive runs on somebody's behalf.
 *
 * Binning seven thousand files used to be seven thousand server actions fired
 * from the browser in a loop. Every one of them opened a connection to the
 * storage and closed it again, which is the FileZilla failure exactly - a NAS
 * hammered with one request per file when one session would have done - and the
 * whole thing died the moment the tab did. The screen it was started from could
 * not be used while it ran, and it said "Working in the background" with no
 * number beside it, which is indistinguishable from a hang.
 *
 * So the work is a row and a worker:
 *
 * - **One driver for the batch.** The expensive part of a file operation on a
 *   remote store is the handshake, not the operation, so the whole point is to
 *   pay it once. That is `moveManyToTrash` and its siblings; this module decides
 *   what to hand them.
 * - **Progress that survives everything.** How far it got is in the row, so the
 *   screen can draw a bar, the reader can navigate away, and closing the tab, a
 *   reload or a redeploy costs the job nothing - the next worker picks it up
 *   where the last one stopped.
 * - **A lease, not a flag.** Two web containers serve at once during a rollover.
 *   An expiry hands a job back from a worker that died mid-batch; a boolean would
 *   strand it for ever.
 *
 * What this is not is a general queue. It is the shape of the one kind of work
 * Drive has that is worth minutes rather than seconds, and a table per shape
 * beats a table that has to describe every shape.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { getDriver } from "@/lib/storage-service";
import { restoreTrash } from "@/lib/trash-service";
import { moveManyToTrash } from "@/lib/trash-service";
import { deleteDriveEntry } from "@/lib/drive-delete";

/**
 * How many paths one pass takes before it writes down where it got to.
 *
 * Small enough that a worker losing power costs at most this many repeated
 * operations, large enough that the write is a rounding error next to the work.
 * Every item in a batch goes over the same open driver.
 */
const BATCH = 100;

/** How long a worker holds a job. Comfortably longer than a batch takes on a
 *  slow share, short enough that a dead worker's job is picked up in a minute or
 *  two rather than an hour. */
const LEASE_MS = 5 * 60_000;

/** The most paths one job may carry. A selection larger than this is somebody
 *  emptying a folder, which has its own operation that does not enumerate. */
export const DRIVE_JOB_MAX_PATHS = 50_000;

export interface DriveJobView {
    readonly id: string;
    readonly kind: core.DriveJobKind;
    readonly label: string;
    readonly total: number;
    readonly done: number;
    readonly failed: number;
    readonly state: core.DriveJobState;
    readonly error: string | null;
    readonly startedAt: string | null;
}

/** What the panel draws, for the jobs this account has running. */
export async function listDriveJobs(ownerId: string): Promise<DriveJobView[]> {
    const rows = await prisma.driveJob.findMany({
        where: { ownerId, state: { in: ["queued", "running"] } },
        orderBy: { createdAt: "asc" },
        take: 20,
        select: {
            id: true,
            kind: true,
            label: true,
            total: true,
            done: true,
            failed: true,
            state: true,
            error: true,
            startedAt: true
        }
    });
    return rows.map((row) => ({
        id: row.id,
        kind: row.kind as core.DriveJobKind,
        label: row.label,
        total: row.total,
        done: row.done,
        failed: row.failed,
        state: row.state as core.DriveJobState,
        error: row.error,
        startedAt: row.startedAt?.toISOString() ?? null
    }));
}

/**
 * Start one, and get on with it.
 *
 * The worker is kicked here rather than waited for: the caller is a button
 * press, and what it needs back is the job's id so the panel can start drawing
 * it. Nothing depends on this call reaching the end - if the process dies
 * between the insert and the kick, the scheduled sweep finds the row still
 * queued and takes it.
 */
export async function startDriveJob(input: {
    ownerId: string;
    connectionId: string;
    kind: core.DriveJobKind;
    label: string;
    paths: readonly string[];
}): Promise<DriveJobView> {
    const paths = [...new Set(input.paths.filter(Boolean))].slice(0, DRIVE_JOB_MAX_PATHS);
    const row = await prisma.driveJob.create({
        data: {
            ownerId: input.ownerId,
            connectionId: input.connectionId,
            kind: input.kind,
            label: input.label,
            pending: JSON.stringify(paths),
            total: paths.length
        },
        select: { id: true }
    });

    // Deliberately not awaited. A failure in here is a job left queued, which the
    // sweep is for; awaiting it would make the button press take as long as the
    // work does, which is the thing being fixed.
    void workDriveJob(row.id).catch((error) => {
        console.error("drive: a job could not be started:", error);
    });

    return {
        id: row.id,
        kind: input.kind,
        label: input.label,
        total: paths.length,
        done: 0,
        failed: 0,
        state: "queued",
        error: null,
        startedAt: null
    };
}

/**
 * Stop one.
 *
 * What has already been moved stays moved: this is "stop", not "undo", and
 * pretending otherwise would mean putting seven thousand files back without being
 * asked to. The worker notices between batches.
 */
export async function cancelDriveJob(ownerId: string, id: string): Promise<void> {
    await prisma.driveJob.updateMany({
        where: { id, ownerId, state: { in: ["queued", "running"] } },
        data: { state: "cancelled", finishedAt: new Date(), pending: "[]" }
    });
}

/**
 * Work one job to the end, or until somebody stops it.
 *
 * Taken under a lease, so a second worker - the sweep, another container - leaves
 * it alone while this one has it. Each batch renews the lease and writes down
 * where it got to, which is what makes an interrupted run resume rather than
 * restart.
 */
export async function workDriveJob(id: string): Promise<void> {
    if (!(await takeJob(id))) return;

    for (;;) {
        const job = await prisma.driveJob.findUnique({
            where: { id },
            select: {
                ownerId: true,
                connectionId: true,
                kind: true,
                pending: true,
                done: true,
                failed: true,
                state: true,
                error: true
            }
        });
        if (!job || job.state !== "running") return;

        const pending = readPaths(job.pending);
        if (pending.length === 0) {
            await prisma.driveJob.update({
                where: { id },
                data: { state: "finished", finishedAt: new Date(), leaseUntil: null }
            });
            return;
        }

        const batch = pending.slice(0, BATCH);
        const rest = pending.slice(BATCH);
        let done = 0;
        let failed = 0;
        let firstError: string | null = null;

        try {
            const outcome = await runBatch(
                job.ownerId,
                job.connectionId,
                job.kind as core.DriveJobKind,
                batch
            );
            done = outcome.done;
            failed = outcome.failures.length;
            firstError = outcome.failures[0]?.reason ?? null;
        } catch (caught) {
            // The whole batch, not one path: an unreachable share, a refused
            // connection. Counted as failures so the numbers still add up, and
            // the reason is what the screen shows.
            failed = batch.length;
            firstError = caught instanceof Error ? caught.message : "Could not reach that storage";
        }

        await prisma.driveJob.update({
            where: { id },
            data: {
                pending: JSON.stringify(rest),
                done: job.done + done,
                failed: job.failed + failed,
                error: job.error ?? firstError,
                leaseUntil: new Date(Date.now() + LEASE_MS)
            }
        });
    }
}

/**
 * Take a queued job, or one whose worker has gone quiet.
 *
 * A conditional update, so two workers reaching for the same row resolve it in
 * the database rather than both believing they won.
 */
async function takeJob(id: string): Promise<boolean> {
    const now = new Date();
    const { count } = await prisma.driveJob.updateMany({
        where: {
            id,
            OR: [
                { state: "queued" },
                { state: "running", leaseUntil: { lt: now } },
                { state: "running", leaseUntil: null }
            ]
        },
        data: { state: "running", startedAt: now, leaseUntil: new Date(now.getTime() + LEASE_MS) }
    });
    return count > 0;
}

/** One batch, over one open connection. */
async function runBatch(
    ownerId: string,
    connectionId: string,
    kind: core.DriveJobKind,
    paths: readonly string[]
): Promise<{ done: number; failures: { path: string; reason: string }[] }> {
    if (kind === "trash") {
        const outcome = await moveManyToTrash(ownerId, connectionId, paths);
        return { done: outcome.moved.length, failures: outcome.failures };
    }

    if (kind === "restore") {
        // The bin's own rows rather than paths, and one at a time: a restore has
        // to find a free destination for each, which is a read per item whatever
        // else happens. It is also the rare one - nobody restores seven thousand
        // files - so it is correct rather than clever.
        const failures: { path: string; reason: string }[] = [];
        let done = 0;
        for (const trashItemId of paths) {
            try {
                await restoreTrash(ownerId, trashItemId);
                done += 1;
            } catch (caught) {
                failures.push({
                    path: trashItemId,
                    reason: caught instanceof Error ? caught.message : "Could not put it back"
                });
            }
        }
        return { done, failures };
    }

    // Permanent. One driver for the batch, same as the bin.
    const failures: { path: string; reason: string }[] = [];
    let done = 0;
    const driver = await getDriver(connectionId, ownerId);
    try {
        for (const path of paths) {
            try {
                await deleteDriveEntry(driver, path);
                done += 1;
            } catch (caught) {
                failures.push({
                    path,
                    reason: caught instanceof Error ? caught.message : "Could not delete it"
                });
            }
        }
    } finally {
        await driver.dispose();
    }
    return { done, failures };
}

function readPaths(json: string): string[] {
    try {
        const parsed: unknown = JSON.parse(json);
        return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
    } catch {
        return [];
    }
}

/**
 * Pick up whatever nobody is working on.
 *
 * The backstop behind the kick in `startDriveJob`: a job whose worker died, one
 * queued by a process that then restarted, one left running by a container that
 * went away mid-rollover. Bounded per pass, because each one it takes runs to
 * completion before this returns.
 */
export async function sweepDriveJobs(): Promise<number> {
    const now = new Date();
    const stale = await prisma.driveJob.findMany({
        where: {
            OR: [
                { state: "queued" },
                { state: "running", leaseUntil: { lt: now } },
                { state: "running", leaseUntil: null }
            ]
        },
        orderBy: { createdAt: "asc" },
        take: 3,
        select: { id: true }
    });
    for (const job of stale) {
        await workDriveJob(job.id).catch((error) => {
            console.error("drive: a job failed while being swept:", error);
        });
    }
    return stale.length;
}

/**
 * Forget the ones that are over.
 *
 * A finished job is worth keeping only long enough for the screen that started it
 * to show that it finished. After that it is a row nobody will read.
 */
export async function pruneDriveJobs(): Promise<number> {
    const { count } = await prisma.driveJob.deleteMany({
        where: {
            state: { in: ["finished", "cancelled"] },
            finishedAt: { lt: new Date(Date.now() - 24 * 60 * 60_000) }
        }
    });
    return count;
}
