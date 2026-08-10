/**
 * Everything the console asks for: what is protected, what its copies are, the
 * plans and destinations behind them, and the changes somebody makes to any of
 * it.
 *
 * Kept apart from `service.ts`, which runs backups. This module never touches a
 * source or a destination's bytes - it reads and writes rows - so the screens
 * can be answered without loading the engine, and the engine can run without
 * loading the screens.
 *
 * Every list is filtered, sorted and paged in the database. The table this feeds
 * is meant to hold hundreds of rows, and a page that loads all of them to count
 * them stops working long before somebody notices why.
 */

import { prisma } from "@polaris/db";
import { Readable } from "node:stream";
import type { Prisma } from "@polaris/db";
import { loadEnv } from "@polaris/config";
import { createReadStream } from "node:fs";
import { sourceFor } from "./sources/registry";
import { refreshResourceCounters } from "./service";
import { encryptCredentials } from "@polaris/storage";
import { nextBackupAt, readPolicy, type RetentionPolicy } from "./policy";
import { isResourceKind, RESOURCE_KINDS_INFO, type ResourceKind } from "./kinds";
import { isSourceLocal, openDestination, type DestinationRow } from "./destination";
import { SourceUnavailableError, stageDir, type SourceResource } from "./sources/types";
import {
    targetSelector,
    type DestinationInput,
    type ListResourcesInput,
    type PlanInput,
    type ProtectInput
} from "./schemas";

/** One row of the console's table. */
export interface ResourceRow {
    readonly id: string;
    readonly kind: ResourceKind | string;
    readonly kindLabel: string;
    readonly name: string;
    readonly status: string;
    readonly planId: string | null;
    readonly planName: string | null;
    readonly lastBackupAt: string | null;
    readonly lastStatus: string | null;
    readonly lastError: string | null;
    readonly nextDueAt: string | null;
    readonly copyCount: number;
    readonly sizeBytes: number;
    /** The destinations its plan writes to, for the column that names them. */
    readonly destinations: readonly string[];
    readonly canRestore: boolean;
}

export interface ResourcePage {
    readonly rows: readonly ResourceRow[];
    readonly nextCursor: string | null;
    /** Everything protected, whatever this page holds - for the summary strip. */
    readonly total: number;
}

const SORT_COLUMNS = {
    name: "name",
    lastBackupAt: "lastBackupAt",
    sizeBytes: "sizeBytes",
    nextDueAt: "nextDueAt"
} as const;

/**
 * The protected things, filtered and paged.
 *
 * The cursor is the last row's id and the sort always ends on it, so two rows
 * with the same timestamp cannot make a page repeat or skip one.
 */
export async function listResources(ownerId: string, input: ListResourcesInput): Promise<ResourcePage> {
    const where: Prisma.ProtectedResourceWhereInput = {
        ownerId,
        ...(input.kind ? { kind: input.kind } : {}),
        ...(input.planId ? { planId: input.planId } : {}),
        ...(input.status ? { status: input.status } : {}),
        ...(input.query ? { name: { contains: input.query, mode: "insensitive" } } : {})
    };
    const column = SORT_COLUMNS[input.sort];
    const [rows, total] = await Promise.all([
        prisma.protectedResource.findMany({
            where,
            orderBy: [{ [column]: input.direction }, { id: "asc" }],
            take: input.limit + 1,
            ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
            select: {
                id: true,
                kind: true,
                name: true,
                status: true,
                planId: true,
                lastBackupAt: true,
                lastStatus: true,
                lastError: true,
                nextDueAt: true,
                copyCount: true,
                sizeBytes: true,
                plan: {
                    select: {
                        name: true,
                        destinations: {
                            orderBy: { position: "asc" },
                            select: { destination: { select: { name: true } } }
                        }
                    }
                }
            }
        }),
        prisma.protectedResource.count({ where: { ownerId } })
    ]);

    const page = rows.slice(0, input.limit);
    return {
        rows: page.map((row) => ({
            id: row.id,
            kind: row.kind,
            kindLabel: isResourceKind(row.kind) ? RESOURCE_KINDS_INFO[row.kind].label : row.kind,
            name: row.name,
            status: row.status,
            planId: row.planId,
            planName: row.plan?.name ?? null,
            lastBackupAt: row.lastBackupAt?.toISOString() ?? null,
            lastStatus: row.lastStatus,
            lastError: row.lastError,
            nextDueAt: row.nextDueAt?.toISOString() ?? null,
            copyCount: row.copyCount,
            sizeBytes: Number(row.sizeBytes),
            destinations: row.plan?.destinations.map((entry) => entry.destination.name) ?? [],
            canRestore: isResourceKind(row.kind) ? RESOURCE_KINDS_INFO[row.kind].canRestore : false
        })),
        nextCursor: rows.length > input.limit ? (page.at(-1)?.id ?? null) : null,
        total
    };
}

/** The numbers across the top of the console. */
export async function backupSummary(ownerId: string): Promise<{
    protectedCount: number;
    copyCount: number;
    storedBytes: number;
    failedRecently: number;
    destinationsDown: number;
}> {
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [totals, failed, down] = await Promise.all([
        prisma.protectedResource.aggregate({
            where: { ownerId },
            _count: { _all: true },
            _sum: { copyCount: true, sizeBytes: true }
        }),
        prisma.backupJob.count({ where: { ownerId, status: "failed", startedAt: { gte: dayAgo } } }),
        prisma.backupDestination.count({ where: { ownerId, status: "unreachable" } })
    ]);
    return {
        protectedCount: totals._count._all,
        copyCount: totals._sum.copyCount ?? 0,
        storedBytes: Number(totals._sum.sizeBytes ?? 0n),
        failedRecently: failed,
        destinationsDown: down
    };
}

/** One copy, as the detail page lists it. */
export interface CopyRow {
    readonly id: string;
    readonly destinationId: string;
    readonly destinationName: string;
    readonly status: string;
    readonly error: string | null;
    readonly sizeBytes: number;
    /** Whether it can be downloaded - a copy beside the source can be read out,
     *  one in a destination can be streamed, a failed one cannot. */
    readonly downloadable: boolean;
}

export interface PointRow {
    readonly id: string;
    readonly takenAt: string;
    readonly expiresAt: string | null;
    readonly status: string;
    readonly sizeBytes: number;
    readonly error: string | null;
    readonly copies: readonly CopyRow[];
}

/** Everything the detail page shows about one protected thing. */
export async function getResourceDetail(
    ownerId: string,
    resourceId: string
): Promise<{
    resource: ResourceRow;
    points: readonly PointRow[];
    jobs: readonly {
        id: string;
        type: string;
        trigger: string;
        status: string;
        startedAt: string;
        finishedAt: string | null;
        error: string | null;
    }[];
} | null> {
    const row = await prisma.protectedResource.findFirst({
        where: { id: resourceId, ownerId },
        select: {
            id: true,
            kind: true,
            name: true,
            status: true,
            planId: true,
            lastBackupAt: true,
            lastStatus: true,
            lastError: true,
            nextDueAt: true,
            copyCount: true,
            sizeBytes: true,
            plan: {
                select: {
                    name: true,
                    destinations: { orderBy: { position: "asc" }, select: { destination: { select: { name: true } } } }
                }
            },
            points: {
                orderBy: { takenAt: "desc" },
                take: 200,
                select: {
                    id: true,
                    takenAt: true,
                    expiresAt: true,
                    status: true,
                    sizeBytes: true,
                    error: true,
                    copies: {
                        select: {
                            id: true,
                            status: true,
                            error: true,
                            sizeBytes: true,
                            destination: { select: { id: true, name: true, kind: true } }
                        }
                    }
                }
            }
        }
    });
    if (!row) return null;

    const jobs = await prisma.backupJob.findMany({
        where: { resourceId, ownerId },
        orderBy: { startedAt: "desc" },
        take: 50,
        select: {
            id: true,
            type: true,
            trigger: true,
            status: true,
            startedAt: true,
            finishedAt: true,
            error: true
        }
    });

    return {
        resource: {
            id: row.id,
            kind: row.kind,
            kindLabel: isResourceKind(row.kind) ? RESOURCE_KINDS_INFO[row.kind].label : row.kind,
            name: row.name,
            status: row.status,
            planId: row.planId,
            planName: row.plan?.name ?? null,
            lastBackupAt: row.lastBackupAt?.toISOString() ?? null,
            lastStatus: row.lastStatus,
            lastError: row.lastError,
            nextDueAt: row.nextDueAt?.toISOString() ?? null,
            copyCount: row.copyCount,
            sizeBytes: Number(row.sizeBytes),
            destinations: row.plan?.destinations.map((entry) => entry.destination.name) ?? [],
            canRestore: isResourceKind(row.kind) ? RESOURCE_KINDS_INFO[row.kind].canRestore : false
        },
        points: row.points.map((point) => ({
            id: point.id,
            takenAt: point.takenAt.toISOString(),
            expiresAt: point.expiresAt?.toISOString() ?? null,
            status: point.status,
            sizeBytes: Number(point.sizeBytes),
            error: point.error,
            copies: point.copies.map((copy) => ({
                id: copy.id,
                destinationId: copy.destination.id,
                destinationName: copy.destination.name,
                status: copy.status,
                error: copy.error,
                sizeBytes: Number(copy.sizeBytes),
                downloadable: copy.status === "available"
            }))
        })),
        jobs: jobs.map((job) => ({
            id: job.id,
            type: job.type,
            trigger: job.trigger,
            status: job.status,
            startedAt: job.startedAt.toISOString(),
            finishedAt: job.finishedAt?.toISOString() ?? null,
            error: job.error
        }))
    };
}

/**
 * Start protecting something.
 *
 * Idempotent on the selector: asking twice for the same database updates the one
 * that is already protected rather than making a second row that would take its
 * own copies of the same thing on its own schedule.
 */
export async function protectResource(ownerId: string, input: ProtectInput): Promise<{ id: string }> {
    const selector = targetSelector(input.target);
    const kind = input.target.kind;
    const source = sourceFor(kind);

    // Whatever the caller called it, the source's own name is the truth. Falling
    // back to the caller's only when the source cannot be read - a server that is
    // off still deserves to be protectable.
    const resolved = await source
        .resolveName({ id: "", ownerId, kind, selector, name: input.name ?? "", config: {} })
        .catch(() => null);
    const name = input.name?.trim() || resolved || defaultNameFor(kind);

    const config: Record<string, unknown> = { ...input.target };
    delete config.kind;
    if ("password" in config) delete config.password;

    const existing = await prisma.protectedResource.findUnique({
        where: { ownerId_selector: { ownerId, selector } },
        select: { id: true }
    });

    const data = {
        name,
        config: JSON.stringify(config),
        ...(input.planId !== undefined ? { planId: input.planId } : {}),
        status: "active"
    };

    if (existing) {
        await prisma.protectedResource.update({ where: { id: existing.id }, data });
        await touchDueDate(existing.id);
        return { id: existing.id };
    }
    const created = await prisma.protectedResource.create({
        data: { ownerId, kind, selector, ...data },
        select: { id: true }
    });
    await touchDueDate(created.id);
    return { id: created.id };
}

function defaultNameFor(kind: ResourceKind): string {
    return RESOURCE_KINDS_INFO[kind].label;
}

/** Recompute when the next scheduled copy is due, after a plan change. */
async function touchDueDate(resourceId: string): Promise<void> {
    const row = await prisma.protectedResource.findUnique({
        where: { id: resourceId },
        select: { planId: true, lastBackupAt: true }
    });
    if (!row) return;
    const policy = await policyOf(row.planId);
    await prisma.protectedResource.update({
        where: { id: resourceId },
        data: { nextDueAt: nextBackupAt(policy, row.lastBackupAt) }
    });
}

async function policyOf(planId: string | null): Promise<RetentionPolicy> {
    if (!planId) return readPolicy({});
    const plan = await prisma.backupPlan.findUnique({
        where: { id: planId },
        select: { every: true, keepLast: true, keepDays: true, maxBytes: true, notifyOnFailure: true }
    });
    return readPolicy(plan ?? {});
}

/** Attach, change or detach the plan behind a protected thing. */
export async function setResourcePlan(ownerId: string, resourceId: string, planId: string | null): Promise<void> {
    const owned = await prisma.protectedResource.findFirst({
        where: { id: resourceId, ownerId },
        select: { id: true }
    });
    if (!owned) throw new SourceUnavailableError("That protected item no longer exists");
    if (planId) {
        const plan = await prisma.backupPlan.findFirst({ where: { id: planId, ownerId }, select: { id: true } });
        if (!plan) throw new SourceUnavailableError("That plan does not exist");
    }
    await prisma.protectedResource.update({ where: { id: resourceId }, data: { planId } });
    await touchDueDate(resourceId);
}

/** Pause or resume the schedule without giving up the copies. */
export async function setResourcePaused(ownerId: string, resourceId: string, paused: boolean): Promise<void> {
    const owned = await prisma.protectedResource.findFirst({
        where: { id: resourceId, ownerId },
        select: { id: true }
    });
    if (!owned) throw new SourceUnavailableError("That protected item no longer exists");
    await prisma.protectedResource.update({
        where: { id: resourceId },
        data: { status: paused ? "paused" : "active", nextDueAt: paused ? null : undefined }
    });
    if (!paused) await touchDueDate(resourceId);
}

/**
 * Stop protecting something.
 *
 * The copies are kept by default. Somebody who stops backing a thing up has not
 * asked for the backups of it to be destroyed, and that is exactly the moment
 * they are most likely to need one. Deleting them is a separate, explicit ask.
 */
export async function unprotectResource(
    ownerId: string,
    resourceId: string,
    options: { deleteCopies?: boolean } = {}
): Promise<void> {
    const row = await prisma.protectedResource.findFirst({
        where: { id: resourceId, ownerId },
        select: { id: true }
    });
    if (!row) return;
    if (options.deleteCopies) {
        const points = await prisma.recoveryPoint.findMany({
            where: { resourceId },
            select: { id: true }
        });
        for (const point of points) await deletePoint(ownerId, point.id);
    }
    await prisma.protectedResource.delete({ where: { id: resourceId } });
}

/** Remove one backup: its bytes in every destination, then its rows. */
export async function deletePoint(ownerId: string, pointId: string): Promise<void> {
    const point = await prisma.recoveryPoint.findFirst({
        where: { id: pointId, resource: { ownerId } },
        select: {
            id: true,
            resource: { select: { id: true, ownerId: true, kind: true, selector: true, name: true, config: true, planId: true } },
            copies: {
                select: {
                    id: true,
                    path: true,
                    destination: {
                        select: { id: true, name: true, kind: true, connectionId: true, hostId: true, basePath: true }
                    }
                }
            }
        }
    });
    if (!point) return;

    for (const copy of point.copies) {
        if (isSourceLocal(copy.destination)) {
            const source = sourceFor(point.resource.kind as ResourceKind);
            await source
                .removeInPlace?.(toSourceResource(point.resource), copy.path)
                .catch(() => undefined);
            continue;
        }
        let handle;
        try {
            handle = await openDestination(copy.destination, ownerId);
            await handle.remove(copy.path);
        } catch {
            // A destination that will not answer keeps its bytes; the row goes
            // either way, because a backup somebody deleted must not come back.
        } finally {
            await handle?.dispose().catch(() => undefined);
        }
    }
    await prisma.recoveryPoint.delete({ where: { id: pointId } });
    await refreshResourceCounters(point.resource.id, await policyOf(point.resource.planId));
}

function toSourceResource(row: {
    id: string;
    ownerId: string;
    kind: string;
    selector: string;
    name: string;
    config: string;
}): SourceResource {
    if (!isResourceKind(row.kind)) throw new SourceUnavailableError(`Unknown kind: ${row.kind}`);
    let config: Record<string, unknown> = {};
    try {
        const parsed: unknown = JSON.parse(row.config);
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
            config = parsed as Record<string, unknown>;
        }
    } catch {
        config = {};
    }
    return { id: row.id, ownerId: row.ownerId, kind: row.kind, selector: row.selector, name: row.name, config };
}

/** Open a copy's bytes, wherever they live. The caller closes nothing else. */
export async function openCopy(
    ownerId: string,
    copyId: string
): Promise<{ stream: ReadableStream<Uint8Array>; fileName: string; sizeBytes: number; dispose: () => Promise<void> }> {
    const copy = await prisma.recoveryPointCopy.findFirst({
        where: { id: copyId, point: { resource: { ownerId } } },
        select: {
            path: true,
            sizeBytes: true,
            status: true,
            destination: {
                select: { id: true, name: true, kind: true, connectionId: true, hostId: true, basePath: true }
            },
            point: {
                select: {
                    metadata: true,
                    resource: {
                        select: { id: true, ownerId: true, kind: true, selector: true, name: true, config: true }
                    }
                }
            }
        }
    });
    if (!copy) throw new SourceUnavailableError("That copy does not exist");
    if (copy.status !== "available") throw new SourceUnavailableError("That copy did not finish being written");

    const fileName = copy.path.split("/").pop() || "backup";
    if (isSourceLocal(copy.destination)) {
        const resource = toSourceResource(copy.point.resource);
        const source = sourceFor(resource.kind);
        if (!source.readInPlace) throw new SourceUnavailableError("That copy cannot be read back");
        const stream = await source.readInPlace(resource, copy.path);
        return { stream, fileName, sizeBytes: Number(copy.sizeBytes), dispose: async () => undefined };
    }
    const handle = await openDestination(copy.destination, ownerId);
    const stream = await handle.get(copy.path);
    return {
        stream,
        fileName,
        sizeBytes: Number(copy.sizeBytes),
        dispose: () => handle.dispose()
    };
}

/**
 * Put a copy back.
 *
 * Destructive, so the caller has already had somebody confirm it. The bytes are
 * staged locally first rather than piped straight from the destination into the
 * source: a restore that dies halfway because a bucket stalled is the worst
 * possible moment for a half-written world.
 */
export async function restoreCopy(ownerId: string, copyId: string, actorId: string): Promise<void> {
    const copy = await prisma.recoveryPointCopy.findFirst({
        where: { id: copyId, point: { resource: { ownerId } } },
        select: {
            id: true,
            point: {
                select: {
                    id: true,
                    metadata: true,
                    resource: {
                        select: { id: true, ownerId: true, kind: true, selector: true, name: true, config: true }
                    }
                }
            }
        }
    });
    if (!copy) throw new SourceUnavailableError("That copy does not exist");
    const resource = toSourceResource(copy.point.resource);
    const source = sourceFor(resource.kind);
    if (!source.restore) {
        throw new SourceUnavailableError(
            `A ${RESOURCE_KINDS_INFO[resource.kind].label.toLowerCase()} cannot be put back from here - download it instead`
        );
    }

    const job = await prisma.backupJob.create({
        data: {
            ownerId,
            resourceId: resource.id,
            pointId: copy.point.id,
            type: "restore",
            trigger: "manual",
            status: "running",
            actorUserId: actorId
        },
        select: { id: true }
    });

    const opened = await openCopy(ownerId, copyId);
    const dir = await stageDir();
    const staged = `${dir}/${opened.fileName}`;
    try {
        const { pipeline } = await import("node:stream/promises");
        const { createWriteStream } = await import("node:fs");
        await pipeline(
            Readable.fromWeb(opened.stream as import("node:stream/web").ReadableStream),
            createWriteStream(staged)
        );
        await opened.dispose();

        let metadata: Record<string, unknown> = {};
        try {
            const parsed: unknown = JSON.parse(copy.point.metadata);
            if (typeof parsed === "object" && parsed !== null) metadata = parsed as Record<string, unknown>;
        } catch {
            metadata = {};
        }
        const body = Readable.toWeb(createReadStream(staged)) as ReadableStream<Uint8Array>;
        await source.restore(resource, body, { ...metadata, fileName: opened.fileName }, actorId);
        await prisma.backupJob.update({
            where: { id: job.id },
            data: { status: "succeeded", finishedAt: new Date() }
        });
    } catch (error) {
        const reason = error instanceof Error ? error.message : "The restore failed";
        await prisma.backupJob.update({
            where: { id: job.id },
            data: { status: "failed", finishedAt: new Date(), error: reason }
        });
        throw error;
    } finally {
        const { rm } = await import("node:fs/promises");
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
}

/** The plans, with what each writes to and how many things use it. */
export async function listPlans(ownerId: string) {
    const plans = await prisma.backupPlan.findMany({
        where: { ownerId },
        orderBy: { name: "asc" },
        select: {
            id: true,
            name: true,
            every: true,
            keepLast: true,
            keepDays: true,
            maxBytes: true,
            notifyOnFailure: true,
            destinations: {
                orderBy: { position: "asc" },
                select: { destinationId: true, destination: { select: { name: true } } }
            },
            _count: { select: { resources: true } }
        }
    });
    return plans.map((plan) => ({
        id: plan.id,
        name: plan.name,
        every: plan.every,
        keepLast: plan.keepLast,
        keepDays: plan.keepDays,
        maxBytes: Number(plan.maxBytes),
        notifyOnFailure: plan.notifyOnFailure,
        destinationIds: plan.destinations.map((entry) => entry.destinationId),
        destinationNames: plan.destinations.map((entry) => entry.destination.name),
        usedBy: plan._count.resources
    }));
}

/** Create a plan, or replace one whole. */
export async function savePlan(ownerId: string, input: PlanInput, planId?: string): Promise<{ id: string }> {
    const owned = await prisma.backupDestination.count({
        where: { ownerId, id: { in: input.destinationIds } }
    });
    if (owned !== input.destinationIds.length) {
        throw new SourceUnavailableError("One of those destinations does not exist");
    }
    const data = {
        name: input.name,
        every: input.every,
        keepLast: input.keepLast,
        keepDays: input.keepDays,
        maxBytes: BigInt(input.maxBytes),
        notifyOnFailure: input.notifyOnFailure
    };
    const plan = planId
        ? await prisma.backupPlan.update({ where: { id: planId }, data, select: { id: true } })
        : await prisma.backupPlan.create({ data: { ownerId, ...data }, select: { id: true } });

    // Replaced rather than merged: the order is the fan-out order, and a diff
    // that preserved rows would have to invent what the new order means.
    await prisma.backupPlanDestination.deleteMany({ where: { planId: plan.id } });
    await prisma.backupPlanDestination.createMany({
        data: input.destinationIds.map((destinationId, position) => ({
            planId: plan.id,
            destinationId,
            position
        }))
    });

    // Everything on this plan has a new schedule as of now.
    const users = await prisma.protectedResource.findMany({
        where: { planId: plan.id },
        select: { id: true }
    });
    for (const resource of users) await touchDueDate(resource.id);
    return { id: plan.id };
}

/** Delete a plan. What used it becomes on-demand rather than unprotected. */
export async function deletePlan(ownerId: string, planId: string): Promise<void> {
    const owned = await prisma.backupPlan.findFirst({ where: { id: planId, ownerId }, select: { id: true } });
    if (!owned) return;
    await prisma.backupPlan.delete({ where: { id: planId } });
    const orphaned = await prisma.protectedResource.findMany({
        where: { ownerId, planId: null },
        select: { id: true }
    });
    for (const resource of orphaned) await touchDueDate(resource.id);
}

/** The destinations, with what each is holding. */
export async function listDestinations(ownerId: string) {
    const rows = await prisma.backupDestination.findMany({
        where: { ownerId },
        orderBy: [{ isDefault: "desc" }, { name: "asc" }],
        select: {
            id: true,
            name: true,
            kind: true,
            basePath: true,
            isDefault: true,
            status: true,
            lastError: true,
            lastCheckedAt: true,
            connection: { select: { id: true, name: true, kind: true } },
            host: { select: { id: true, name: true } },
            _count: { select: { copies: true, plans: true } }
        }
    });
    const sizes = await prisma.recoveryPointCopy.groupBy({
        by: ["destinationId"],
        where: { destination: { ownerId }, status: "available" },
        _sum: { sizeBytes: true }
    });
    const bytesByDestination = new Map(sizes.map((row) => [row.destinationId, Number(row._sum.sizeBytes ?? 0n)]));
    return rows.map((row) => ({
        id: row.id,
        name: row.name,
        kind: row.kind,
        basePath: row.basePath,
        isDefault: row.isDefault,
        status: row.status,
        lastError: row.lastError,
        lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
        via: row.connection?.name ?? row.host?.name ?? null,
        viaKind: row.connection?.kind ?? (row.host ? "host" : null),
        copyCount: row._count.copies,
        usedByPlans: row._count.plans,
        storedBytes: bytesByDestination.get(row.id) ?? 0
    }));
}

/** Add a destination. */
export async function createDestination(ownerId: string, input: DestinationInput): Promise<{ id: string }> {
    if (input.kind === "connection") {
        const owned = await prisma.storageConnection.findFirst({
            where: { id: input.connectionId, ownerId },
            select: { id: true }
        });
        if (!owned) throw new SourceUnavailableError("That storage connection does not exist");
    }
    if (input.kind === "host") {
        const owned = await prisma.host.findFirst({ where: { id: input.hostId, ownerId }, select: { id: true } });
        if (!owned) throw new SourceUnavailableError("That server does not exist");
    }
    const created = await prisma.backupDestination.create({
        data: {
            ownerId,
            name: input.name,
            kind: input.kind,
            basePath: "basePath" in input ? input.basePath : "",
            connectionId: input.kind === "connection" ? input.connectionId : null,
            hostId: input.kind === "host" ? input.hostId : null
        },
        select: { id: true }
    });
    return created;
}

/**
 * Delete a destination, refusing while it still holds copies.
 *
 * The rows would otherwise survive as pointers to bytes nobody can fetch, which
 * reads on screen exactly like a backup that exists.
 */
export async function deleteDestination(ownerId: string, destinationId: string): Promise<void> {
    const row = await prisma.backupDestination.findFirst({
        where: { id: destinationId, ownerId },
        select: { id: true, isDefault: true, _count: { select: { copies: true } } }
    });
    if (!row) return;
    if (row._count.copies > 0) {
        throw new SourceUnavailableError(
            "That destination still holds copies. Delete them first, or keep it so they stay reachable."
        );
    }
    if (row.isDefault) {
        throw new SourceUnavailableError("That is the default destination. Make another one the default first.");
    }
    await prisma.backupDestination.delete({ where: { id: destinationId } });
}

/** Open a destination and put it back to `active`, or record why it refused. */
export async function testDestination(
    ownerId: string,
    destinationId: string
): Promise<{ ok: boolean; error?: string; usedBytes?: number; freeBytes?: number }> {
    const row = await prisma.backupDestination.findFirst({
        where: { id: destinationId, ownerId },
        select: { id: true, name: true, kind: true, connectionId: true, hostId: true, basePath: true }
    });
    if (!row) return { ok: false, error: "That destination does not exist" };
    if (isSourceLocal(row)) {
        // There is nothing to open: it is wherever the source is.
        await markDestination(row.id, true);
        return { ok: true };
    }
    let handle;
    try {
        handle = await openDestination(row as DestinationRow, ownerId);
        const usage: { used?: bigint; free?: bigint } = await handle
            .usage()
            .catch(() => ({}) as { used?: bigint; free?: bigint });
        await markDestination(row.id, true);
        return {
            ok: true,
            usedBytes: usage.used === undefined ? undefined : Number(usage.used),
            freeBytes: usage.free === undefined ? undefined : Number(usage.free)
        };
    } catch (error) {
        const reason = error instanceof Error ? error.message : "It did not answer";
        await markDestination(row.id, false, reason);
        return { ok: false, error: reason };
    } finally {
        await handle?.dispose().catch(() => undefined);
    }
}

async function markDestination(id: string, ok: boolean, error?: string): Promise<void> {
    await prisma.backupDestination.update({
        where: { id },
        data: { status: ok ? "active" : "unreachable", lastCheckedAt: new Date(), lastError: ok ? null : (error ?? null) }
    });
}

/** What has run lately, newest first. */
export async function listActivity(ownerId: string, limit = 100) {
    const jobs = await prisma.backupJob.findMany({
        where: { ownerId },
        orderBy: { startedAt: "desc" },
        take: limit,
        select: {
            id: true,
            type: true,
            trigger: true,
            status: true,
            startedAt: true,
            finishedAt: true,
            bytes: true,
            error: true,
            resourceId: true
        }
    });
    const names = new Map(
        (
            await prisma.protectedResource.findMany({
                where: { id: { in: jobs.map((job) => job.resourceId).filter((id): id is string => Boolean(id)) } },
                select: { id: true, name: true }
            })
        ).map((row) => [row.id, row.name])
    );
    return jobs.map((job) => ({
        id: job.id,
        type: job.type,
        trigger: job.trigger,
        status: job.status,
        startedAt: job.startedAt.toISOString(),
        finishedAt: job.finishedAt?.toISOString() ?? null,
        bytes: Number(job.bytes),
        error: job.error,
        resourceId: job.resourceId,
        resourceName: job.resourceId ? (names.get(job.resourceId) ?? null) : null
    }));
}

/** Store an external credential against a protected thing, sealed. */
export async function sealResourceSecret(resourceId: string, secret: Record<string, unknown>): Promise<void> {
    const sealed = encryptCredentials(secret, loadEnv().POLARIS_MASTER_KEY);
    await prisma.protectedResource.update({
        where: { id: resourceId },
        data: {
            encryptedCredential: sealed.ciphertext,
            credentialNonce: sealed.nonce,
            credentialKeyId: sealed.keyId
        }
    });
}

/**
 * Keep a game server's own schedule control working, by making it the same act
 * as setting a plan in the console.
 *
 * The World screen has had an "automatic backups" card since before any of this
 * existed. Left alone it would go on writing a schedule into that app's config
 * that nothing reads any more - a control that appears to work and silently does
 * nothing, which is the exact failure this rebuild is about.
 *
 * So it writes through: the world becomes a protected thing if it is not one,
 * and the schedule becomes a plan of its own named after the server. Turning it
 * off detaches the plan rather than deleting the world's copies.
 */
export async function applyWorldSchedule(
    ownerId: string,
    installedAppId: string,
    serverName: string,
    rules: { every: string; keepLast: number; maxBytes: number; notifyOnFailure: boolean }
): Promise<void> {
    const selector = `minecraft-world:${installedAppId}`;
    const resource = await prisma.protectedResource.upsert({
        where: { ownerId_selector: { ownerId, selector } },
        create: { ownerId, kind: "minecraft-world", selector, name: serverName, config: "{}" },
        update: { name: serverName },
        select: { id: true, planId: true }
    });

    if (rules.every === "off") {
        await prisma.protectedResource.update({
            where: { id: resource.id },
            data: { planId: null, nextDueAt: null }
        });
        return;
    }

    // Beside the source is where a world's archive already goes, so that is what
    // this plan writes to. Anywhere else is a decision for the console, which is
    // why changing it there is not undone by saving here.
    const sourceLocal = await prisma.backupDestination.findFirst({
        where: { ownerId, kind: "source-local" },
        select: { id: true }
    });
    if (!sourceLocal) throw new SourceUnavailableError("There is nowhere to keep this server's copies");

    const name = `${serverName} - world`;
    const existing = await prisma.backupPlan.findUnique({
        where: { ownerId_name: { ownerId, name } },
        select: { id: true }
    });
    const planId = existing
        ? (
              await prisma.backupPlan.update({
                  where: { id: existing.id },
                  data: {
                      every: rules.every,
                      keepLast: rules.keepLast,
                      maxBytes: BigInt(rules.maxBytes),
                      notifyOnFailure: rules.notifyOnFailure
                  },
                  select: { id: true }
              })
          ).id
        : (
              await prisma.backupPlan.create({
                  data: {
                      ownerId,
                      name,
                      every: rules.every,
                      keepLast: rules.keepLast,
                      keepDays: 0,
                      maxBytes: BigInt(rules.maxBytes),
                      notifyOnFailure: rules.notifyOnFailure,
                      destinations: { create: { destinationId: sourceLocal.id, position: 0 } }
                  },
                  select: { id: true }
              })
          ).id;

    await prisma.protectedResource.update({ where: { id: resource.id }, data: { planId } });
    await touchDueDate(resource.id);
}
