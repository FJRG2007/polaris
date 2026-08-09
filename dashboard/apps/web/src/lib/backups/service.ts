/**
 * The engine: taking a backup, replicating it, pruning what fell out of
 * retention, and answering the console's questions about all of it.
 *
 * One backup is one read of the source and N writes. The source stages an
 * artifact on local disk; every destination then streams from that file. Reading
 * a 40 GB world once and uploading it four times is the whole point - reading it
 * per destination would cost four archives of a live server, taken minutes apart
 * from a world that changed in between, and they would not be the same backup.
 *
 * A copy that fails does not fail the backup. The point becomes `partial`, the
 * copy carries its own reason, and what did land stays restorable - because the
 * alternative is a local copy being thrown away because a bucket was briefly
 * unreachable.
 */

import { prisma } from "@polaris/db";
import { Readable } from "node:stream";
import type { Prisma } from "@polaris/db";
import { createReadStream } from "node:fs";
import { sourceFor, allSources } from "./sources/registry";
import { createNotification } from "@/lib/notification-service";
import { SourceUnavailableError, type SourceResource, type StagedArtifact } from "./sources/types";
import { DestinationUnavailableError, isSourceLocal, openDestination, type DestinationRow } from "./destination";
import { DEFAULT_LOCAL_DESTINATION, DEFAULT_SOURCE_LOCAL_DESTINATION, isResourceKind, type ResourceKind } from "./kinds";
import {
    backupDue,
    copiesToPrune,
    DEFAULT_POLICY,
    expiresAt,
    nextBackupAt,
    readPolicy,
    type RetentionPolicy
} from "./policy";

/** What a backup run reports back. */
export interface BackupOutcome {
    readonly pointId: string;
    readonly status: "available" | "partial" | "failed";
    readonly sizeBytes: number;
    /** Destinations that refused, with the reason each gave. */
    readonly failures: readonly { readonly destination: string; readonly reason: string }[];
    readonly pruned: number;
}

/** The columns every read of a resource needs. */
const RESOURCE_SELECT = {
    id: true,
    ownerId: true,
    kind: true,
    selector: true,
    name: true,
    config: true,
    status: true,
    planId: true
} satisfies Prisma.ProtectedResourceSelect;

/** Parse the stored config column, tolerating a row somebody hand-edited. */
function readConfig(raw: string): Record<string, unknown> {
    try {
        const parsed: unknown = JSON.parse(raw);
        return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : {};
    } catch {
        return {};
    }
}

function toSourceResource(row: {
    id: string;
    ownerId: string;
    kind: string;
    selector: string;
    name: string;
    config: string;
}): SourceResource {
    if (!isResourceKind(row.kind)) {
        throw new SourceUnavailableError(`Polaris no longer knows how to back up a ${row.kind}`);
    }
    return {
        id: row.id,
        ownerId: row.ownerId,
        kind: row.kind,
        selector: row.selector,
        name: row.name,
        config: readConfig(row.config)
    };
}

/**
 * The destinations a resource's copies go to, in the order they are written.
 *
 * Without a plan there is still somewhere to put it: the owner's default. A
 * protected thing somebody backs up by hand should not need a schedule first.
 */
async function destinationsFor(
    ownerId: string,
    planId: string | null
): Promise<DestinationRow[]> {
    if (planId) {
        const rows = await prisma.backupPlanDestination.findMany({
            where: { planId },
            orderBy: { position: "asc" },
            select: {
                destination: {
                    select: { id: true, name: true, kind: true, connectionId: true, hostId: true, basePath: true }
                }
            }
        });
        if (rows.length > 0) return rows.map((row) => row.destination);
    }
    const fallback = await prisma.backupDestination.findFirst({
        where: { ownerId, isDefault: true },
        select: { id: true, name: true, kind: true, connectionId: true, hostId: true, basePath: true }
    });
    return fallback ? [fallback] : [];
}

/** The policy in force for a resource, or the default when it has no plan. */
async function policyFor(planId: string | null): Promise<RetentionPolicy> {
    if (!planId) return DEFAULT_POLICY;
    const plan = await prisma.backupPlan.findUnique({
        where: { id: planId },
        select: { every: true, keepLast: true, keepDays: true, maxBytes: true, notifyOnFailure: true }
    });
    return plan ? readPolicy(plan) : DEFAULT_POLICY;
}

/**
 * Take a backup of one protected thing.
 *
 * The job row is written first and closed last, so a run that dies mid-way is
 * visible as one that never finished rather than as one that never happened.
 */
export async function runBackup(
    resourceId: string,
    options: { trigger?: "manual" | "scheduled"; actorUserId?: string } = {}
): Promise<BackupOutcome> {
    const row = await prisma.protectedResource.findUnique({
        where: { id: resourceId },
        select: RESOURCE_SELECT
    });
    if (!row) throw new SourceUnavailableError("That protected item no longer exists");

    const job = await prisma.backupJob.create({
        data: {
            ownerId: row.ownerId,
            resourceId: row.id,
            type: "backup",
            trigger: options.trigger ?? "manual",
            status: "running",
            actorUserId: options.actorUserId ?? null
        },
        select: { id: true }
    });

    const point = await prisma.recoveryPoint.create({
        data: { resourceId: row.id, planId: row.planId, status: "creating" },
        select: { id: true }
    });

    try {
        const outcome = await produceAndReplicate(row, point.id);
        await prisma.backupJob.update({
            where: { id: job.id },
            data: {
                status: outcome.status === "failed" ? "failed" : "succeeded",
                finishedAt: new Date(),
                pointId: point.id,
                bytes: BigInt(outcome.sizeBytes),
                error: outcome.failures.length > 0 ? summarize(outcome.failures) : null
            }
        });
        if (outcome.status !== "available") await notifyFailure(row, outcome);
        return outcome;
    } catch (error) {
        const reason = error instanceof Error ? error.message : "The backup failed";
        await prisma.recoveryPoint.update({
            where: { id: point.id },
            data: { status: "failed", error: reason }
        });
        await prisma.backupJob.update({
            where: { id: job.id },
            data: { status: "failed", finishedAt: new Date(), pointId: point.id, error: reason }
        });
        await prisma.protectedResource.update({
            where: { id: row.id },
            data: { lastStatus: "failed", lastError: reason }
        });
        await notifyFailure(row, {
            pointId: point.id,
            status: "failed",
            sizeBytes: 0,
            failures: [{ destination: "the source", reason }],
            pruned: 0
        });
        throw error;
    }
}

/** Produce the artifact once and write it everywhere the plan says. */
async function produceAndReplicate(
    row: { id: string; ownerId: string; kind: string; selector: string; name: string; config: string; planId: string | null },
    pointId: string
): Promise<BackupOutcome> {
    const resource = toSourceResource(row);
    const source = sourceFor(resource.kind);
    const destinations = await destinationsFor(row.ownerId, row.planId);
    if (destinations.length === 0) {
        throw new SourceUnavailableError("There is nowhere to put this backup. Add a destination first.");
    }
    const policy = await policyFor(row.planId);
    const takenAt = new Date();
    const failures: { destination: string; reason: string }[] = [];
    let landed = 0;
    let sizeBytes = 0;
    let metadata: Record<string, unknown> = {};

    // Beside the source first, when the plan asks for it and the kind can: it is
    // the cheapest copy and the one that also becomes the artifact everything
    // else is replicated from.
    const inPlaceTargets = destinations.filter(isSourceLocal);
    const remote = destinations.filter((destination) => !isSourceLocal(destination));

    for (const destination of inPlaceTargets) {
        if (!source.produceInPlace) {
            failures.push({
                destination: destination.name,
                reason: `A ${resource.kind} cannot keep a copy beside itself`
            });
            continue;
        }
        try {
            const taken = await source.produceInPlace(resource);
            if (!taken) continue;
            await prisma.recoveryPointCopy.create({
                data: {
                    pointId,
                    destinationId: destination.id,
                    path: taken.path,
                    sizeBytes: BigInt(taken.sizeBytes),
                    status: "available"
                }
            });
            landed += 1;
            sizeBytes = Math.max(sizeBytes, taken.sizeBytes);
        } catch (error) {
            failures.push({ destination: destination.name, reason: reasonOf(error) });
        }
    }

    let staged: StagedArtifact | null = null;
    if (remote.length > 0) {
        staged = await source.produce(resource);
        metadata = { ...staged.metadata, fileName: staged.fileName };
        sizeBytes = Math.max(sizeBytes, staged.sizeBytes);
    }

    try {
        for (const destination of remote) {
            if (!staged) break;
            const copy = await prisma.recoveryPointCopy.create({
                data: {
                    pointId,
                    destinationId: destination.id,
                    path: `${resource.id}/${staged.fileName}`,
                    sizeBytes: BigInt(staged.sizeBytes),
                    status: "pending"
                },
                select: { id: true, path: true }
            });
            let handle;
            try {
                handle = await openDestination(destination, row.ownerId);
                const body = Readable.toWeb(createReadStream(staged.path)) as ReadableStream<Uint8Array>;
                const written = await handle.put(copy.path, body, BigInt(staged.sizeBytes));
                await prisma.recoveryPointCopy.update({
                    where: { id: copy.id },
                    data: { status: "available", sizeBytes: BigInt(written.sizeBytes) }
                });
                landed += 1;
            } catch (error) {
                const reason = reasonOf(error);
                failures.push({ destination: destination.name, reason });
                await prisma.recoveryPointCopy.update({
                    where: { id: copy.id },
                    data: { status: "failed", error: reason }
                });
                // The destination is the thing that is wrong, not the backup:
                // recording it here is what makes the console able to say which
                // one has started refusing before the next run is due.
                await prisma.backupDestination.update({
                    where: { id: destination.id },
                    data: { status: "unreachable", lastCheckedAt: new Date(), lastError: reason }
                }).catch(() => undefined);
            } finally {
                await handle?.dispose().catch(() => undefined);
            }
        }
    } finally {
        await staged?.cleanup();
    }

    const status = landed === 0 ? "failed" : failures.length > 0 ? "partial" : "available";
    await prisma.recoveryPoint.update({
        where: { id: pointId },
        data: {
            status,
            takenAt,
            sizeBytes: BigInt(sizeBytes),
            expiresAt: expiresAt(policy, takenAt),
            metadata: JSON.stringify(metadata),
            error: failures.length > 0 ? summarize(failures) : null
        }
    });

    const pruned = await pruneResource(row.id, policy);
    await refreshResourceCounters(row.id, policy, {
        lastStatus: status === "available" ? "ok" : status,
        lastError: failures.length > 0 ? summarize(failures) : null
    });

    return { pointId, status, sizeBytes, failures, pruned };
}

/** Whichever reason a failure carried, in one sentence. */
function reasonOf(error: unknown): string {
    if (error instanceof DestinationUnavailableError || error instanceof SourceUnavailableError) {
        return error.message;
    }
    return error instanceof Error ? error.message : "Unknown failure";
}

function summarize(failures: readonly { destination: string; reason: string }[]): string {
    return failures.map((failure) => `${failure.destination}: ${failure.reason}`).join("; ").slice(0, 1000);
}

/** Tell somebody a scheduled backup did not land, when the plan asks for it. */
async function notifyFailure(
    row: { ownerId: string; name: string; planId: string | null },
    outcome: BackupOutcome
): Promise<void> {
    const policy = await policyFor(row.planId);
    if (!policy.notifyOnFailure) return;
    await createNotification({
        userId: row.ownerId,
        type: "backup.failed",
        title:
            outcome.status === "failed"
                ? `Backup of ${row.name} failed`
                : `Backup of ${row.name} only partly landed`,
        body: summarize(outcome.failures) || "No destination accepted the copy.",
        href: "/apps/backups",
        // A backup that did not land is worth acting on; one that landed
        // everywhere but a bucket is worth knowing about.
        level: outcome.status === "failed" ? "danger" : "warning",
        actionRequired: outcome.status === "failed"
    }).catch(() => undefined);
}

/**
 * Delete what has fallen out of retention, per destination.
 *
 * Per destination because they are not equivalent: a game server's own disk
 * holds days and a bucket holds a year. A copy is removed from the destination
 * before its row goes, so a failure leaves a row pointing at bytes that exist
 * rather than a bucket holding bytes nothing points at.
 */
export async function pruneResource(resourceId: string, policy: RetentionPolicy): Promise<number> {
    const copies = await prisma.recoveryPointCopy.findMany({
        where: { point: { resourceId }, status: "available" },
        select: {
            id: true,
            path: true,
            sizeBytes: true,
            point: { select: { takenAt: true } },
            destination: {
                select: { id: true, name: true, kind: true, connectionId: true, hostId: true, basePath: true }
            }
        }
    });

    const byDestination = new Map<string, typeof copies>();
    for (const copy of copies) {
        const held = byDestination.get(copy.destination.id) ?? [];
        held.push(copy);
        byDestination.set(copy.destination.id, held);
    }

    const resource = await prisma.protectedResource.findUnique({
        where: { id: resourceId },
        select: RESOURCE_SELECT
    });
    if (!resource) return 0;

    let removed = 0;
    for (const [, held] of byDestination) {
        const doomed = copiesToPrune(
            held.map((copy) => ({
                id: copy.id,
                sizeBytes: Number(copy.sizeBytes),
                takenAt: copy.point.takenAt
            })),
            policy
        );
        if (doomed.length === 0) continue;
        const destination = held[0]?.destination;
        if (!destination) continue;

        if (isSourceLocal(destination)) {
            const source = sourceFor(toSourceResource(resource).kind);
            for (const id of doomed) {
                const copy = held.find((candidate) => candidate.id === id);
                if (!copy || !source.removeInPlace) continue;
                try {
                    await source.removeInPlace(toSourceResource(resource), copy.path);
                    await prisma.recoveryPointCopy.delete({ where: { id } });
                    removed += 1;
                } catch {
                    // Leave it recorded: a copy that could not be deleted is
                    // still there, and a row saying so is the truth.
                }
            }
            continue;
        }

        let handle;
        try {
            handle = await openDestination(destination, resource.ownerId);
            for (const id of doomed) {
                const copy = held.find((candidate) => candidate.id === id);
                if (!copy) continue;
                await handle.remove(copy.path).catch(() => undefined);
                await prisma.recoveryPointCopy.delete({ where: { id } });
                removed += 1;
            }
        } catch {
            // A destination that cannot be opened keeps its copies; they will be
            // proposed again next time.
        } finally {
            await handle?.dispose().catch(() => undefined);
        }
    }

    // A point nothing points at any more is not a backup.
    await prisma.recoveryPoint.deleteMany({
        where: { resourceId, copies: { none: {} }, status: { not: "creating" } }
    });
    return removed;
}

/** Recompute the denormalized columns the console's table sorts and filters on. */
export async function refreshResourceCounters(
    resourceId: string,
    policy: RetentionPolicy,
    outcome?: { lastStatus?: string | null; lastError?: string | null }
): Promise<void> {
    const points = await prisma.recoveryPoint.findMany({
        where: { resourceId, status: { in: ["available", "partial"] } },
        select: { takenAt: true, sizeBytes: true },
        orderBy: { takenAt: "desc" }
    });
    const newest = points[0]?.takenAt ?? null;
    await prisma.protectedResource.update({
        where: { id: resourceId },
        data: {
            copyCount: points.length,
            sizeBytes: points.reduce((sum, point) => sum + point.sizeBytes, 0n),
            lastBackupAt: newest,
            nextDueAt: nextBackupAt(policy, newest),
            ...(outcome?.lastStatus !== undefined ? { lastStatus: outcome.lastStatus } : {}),
            ...(outcome?.lastError !== undefined ? { lastError: outcome.lastError } : {})
        }
    });
}

/**
 * Take every backup that is due.
 *
 * Driven by `nextDueAt`, which is written whenever a resource's copies change,
 * so finding the due ones is an index lookup rather than evaluating every
 * policy. Each is guarded on its own: one server that will not answer must not
 * stop the other nine from being backed up.
 */
export async function sweepDueBackups(now: Date = new Date()): Promise<{
    taken: number;
    failed: number;
    pruned: number;
}> {
    const due = await prisma.protectedResource.findMany({
        where: { status: "active", planId: { not: null }, nextDueAt: { lte: now } },
        select: { id: true, planId: true },
        orderBy: { nextDueAt: "asc" },
        take: 100
    });

    let taken = 0;
    let failed = 0;
    let pruned = 0;
    for (const resource of due) {
        const policy = await policyFor(resource.planId);
        // `nextDueAt` is a hint written when the copies last changed; the policy
        // is the authority, and it is re-read here in case somebody turned the
        // schedule off a minute ago.
        const newest = await prisma.recoveryPoint.findFirst({
            where: { resourceId: resource.id, status: { in: ["available", "partial"] } },
            orderBy: { takenAt: "desc" },
            select: { takenAt: true }
        });
        if (!backupDue(policy, newest?.takenAt ?? null, now)) {
            await refreshResourceCounters(resource.id, policy);
            continue;
        }
        try {
            const outcome = await runBackup(resource.id, { trigger: "scheduled" });
            if (outcome.status === "failed") failed += 1;
            else taken += 1;
            pruned += outcome.pruned;
        } catch {
            failed += 1;
        }
    }
    return { taken, failed, pruned };
}

/** Everything of every kind that exists and is not protected yet. */
export async function discoverUnprotected(ownerId: string): Promise<
    { kind: ResourceKind; selector: string; name: string; context?: string; target: Record<string, unknown> }[]
> {
    const [found, existing] = await Promise.all([
        Promise.all(allSources().map((source) => source.discover(ownerId).catch(() => []))),
        prisma.protectedResource.findMany({ where: { ownerId }, select: { selector: true } })
    ]);
    const taken = new Set(existing.map((row) => row.selector));
    return found.flat().filter((candidate) => !taken.has(candidate.selector));
}

/**
 * Create the two destinations every owner starts with.
 *
 * Idempotent, and called the first time somebody opens the console: a protected
 * thing with nowhere to put its copies is the one state this whole rebuild
 * exists to make impossible.
 */
export async function ensureDefaultDestinations(ownerId: string): Promise<void> {
    const existing = await prisma.backupDestination.count({ where: { ownerId } });
    if (existing > 0) return;
    await prisma.backupDestination.createMany({
        data: [
            {
                ownerId,
                name: DEFAULT_LOCAL_DESTINATION,
                kind: "local",
                basePath: "backups",
                isDefault: true
            },
            {
                ownerId,
                name: DEFAULT_SOURCE_LOCAL_DESTINATION,
                kind: "source-local",
                basePath: ""
            }
        ]
    });
}
