/**
 * Choosing where copies go by default, and moving the ones already taken.
 *
 * Every owner starts with the data dir as the default, because it is the one
 * destination that exists before anything is set up. It shares a disk with what
 * it protects, so the moment a NAS or another server is connected the copies
 * belong there - and the ones already written have to be able to follow without
 * being taken again.
 *
 * A move writes each copy to the new destination, marks it available there, and
 * only then removes the old one: an interrupted move leaves a point with two
 * copies, never with none. The bytes are moved as they are, sealed or not, so
 * nothing is decrypted on the way.
 */

import { prisma } from "@polaris/db";
import { SourceUnavailableError } from "./sources/types";
import { isSourceLocal, openDestination, type DestinationHandle, type DestinationRow } from "./destination";

const DESTINATION_FIELDS = {
    id: true,
    name: true,
    kind: true,
    connectionId: true,
    hostId: true,
    basePath: true
} as const;

/** Copies looked at per round, so a destination with thousands never loads at once. */
const MOVE_BATCH = 50;

/** A move gives up after this many copies in a row did not arrive: the target is not taking them. */
const MAX_FAILURES_IN_A_ROW = 3;

/** Sources whose move is running in this process. */
const moving = new Set<string>();

/** Closing the jobs of moves an earlier process lost, once, before this one starts any. */
let swept: Promise<unknown> | null = null;

function sweepLostMoves(): Promise<unknown> {
    swept ??= prisma.backupJob
        .updateMany({
            where: { type: "replicate", status: "running", resourceId: null },
            data: { status: "failed", finishedAt: new Date(), error: "Stopped before it finished" }
        })
        .catch((error: unknown) => {
            swept = null;
            throw error;
        });
    return swept;
}

async function ownedDestination(ownerId: string, id: string): Promise<DestinationRow> {
    const row = await prisma.backupDestination.findFirst({
        where: { id, ownerId },
        select: DESTINATION_FIELDS
    });
    if (!row) throw new SourceUnavailableError("That destination does not exist");
    return row;
}

/**
 * Make one destination the one copies go to when a plan names none.
 *
 * Copies beside the source are refused: most kinds cannot keep one, so a default
 * of that kind would be a default most protected things cannot use.
 */
export async function setDefaultDestination(ownerId: string, destinationId: string): Promise<void> {
    const row = await ownedDestination(ownerId, destinationId);
    if (isSourceLocal(row)) {
        throw new SourceUnavailableError("Copies beside the source cannot be the default");
    }
    await prisma.$transaction([
        prisma.backupDestination.updateMany({
            where: { ownerId, isDefault: true, id: { not: destinationId } },
            data: { isDefault: false }
        }),
        prisma.backupDestination.update({ where: { id: destinationId }, data: { isDefault: true } })
    ]);
}

/** Whether a move out of this destination is running here now. */
export function isMoving(destinationId: string): boolean {
    return moving.has(destinationId);
}

/**
 * Start moving every available copy from one destination to another.
 *
 * Checks what can be refused before answering, then runs in the background and
 * records itself as a `replicate` job, so Activity says when it finished and
 * what it moved.
 */
export async function startMovingCopies(input: {
    ownerId: string;
    fromId: string;
    toId: string;
    actorId: string;
}): Promise<{ jobId: string; count: number }> {
    if (input.fromId === input.toId) {
        throw new SourceUnavailableError("Choose a different destination to move the copies to");
    }
    const [from, to] = await Promise.all([
        ownedDestination(input.ownerId, input.fromId),
        ownedDestination(input.ownerId, input.toId)
    ]);
    if (isSourceLocal(from) || isSourceLocal(to)) {
        throw new SourceUnavailableError("Copies beside the source cannot be moved");
    }
    if (moving.has(from.id)) {
        throw new SourceUnavailableError("Those copies are already being moved");
    }
    const count = await prisma.recoveryPointCopy.count({
        where: { destinationId: from.id, status: "available" }
    });
    if (count === 0) throw new SourceUnavailableError("That destination holds no copies to move");

    // A move this process lost to a restart never closed its job; it says so
    // instead of reading as running for ever.
    await sweepLostMoves();
    const job = await prisma.backupJob.create({
        data: { ownerId: input.ownerId, type: "replicate", actorUserId: input.actorId },
        select: { id: true }
    });
    moving.add(from.id);
    void moveCopies(from, to, input.ownerId)
        .then(({ moved, bytes, failures }) =>
            prisma.backupJob.update({
                where: { id: job.id },
                data: {
                    status: moved === 0 && failures.length > 0 ? "failed" : "succeeded",
                    finishedAt: new Date(),
                    bytes: BigInt(bytes),
                    error: failures.length > 0 ? failures.slice(0, 3).join("; ") : null
                }
            })
        )
        .catch((error: unknown) => {
            console.error("polaris: moving backup copies failed:", error);
            return prisma.backupJob.update({
                where: { id: job.id },
                data: { status: "failed", finishedAt: new Date(), error: reasonOf(error) }
            });
        })
        .catch(() => undefined)
        .finally(() => moving.delete(from.id));
    return { jobId: job.id, count };
}

function reasonOf(error: unknown): string {
    return error instanceof Error ? error.message.slice(0, 500) : "It did not finish";
}

/** One copy, from where it is to where it goes. Exported for the tests. */
export async function moveOneCopy(
    copy: { id: string; pointId: string; path: string; sizeBytes: bigint; sealedWith: string | null },
    source: DestinationHandle,
    target: DestinationHandle,
    toId: string
): Promise<number> {
    const existing = await prisma.recoveryPointCopy.findUnique({
        where: { pointId_destinationId: { pointId: copy.pointId, destinationId: toId } },
        select: { id: true, status: true, sizeBytes: true }
    });
    let landed: number;
    if (existing?.status === "available") {
        // Already there - a plan that writes to both, or a move that stopped after
        // writing this one. Only the old copy is left to remove.
        landed = Number(existing.sizeBytes);
    } else {
        const row =
            existing ??
            (await prisma.recoveryPointCopy.create({
                data: {
                    pointId: copy.pointId,
                    destinationId: toId,
                    path: copy.path,
                    sizeBytes: copy.sizeBytes,
                    status: "pending",
                    sealedWith: copy.sealedWith
                },
                select: { id: true, status: true, sizeBytes: true }
            }));
        const abandon = async (reason: string): Promise<void> => {
            if (existing) {
                await prisma.recoveryPointCopy
                    .update({ where: { id: row.id }, data: { status: "failed", error: reason } })
                    .catch(() => undefined);
                return;
            }
            await prisma.recoveryPointCopy.delete({ where: { id: row.id } }).catch(() => undefined);
        };
        try {
            const written = await target.put(copy.path, await source.get(copy.path), copy.sizeBytes);
            landed = written.sizeBytes;
        } catch (error) {
            if (!existing) await target.remove(copy.path).catch(() => undefined);
            await abandon(reasonOf(error));
            throw error;
        }
        if (BigInt(landed) !== copy.sizeBytes) {
            await target.remove(copy.path).catch(() => undefined);
            await abandon("The copy arrived a different size");
            throw new Error("The copy arrived a different size");
        }
        await prisma.recoveryPointCopy.update({
            where: { id: row.id },
            data: { status: "available", sizeBytes: BigInt(landed), path: copy.path, error: null, sealedWith: copy.sealedWith }
        });
    }
    // The new copy is in place; the old one can go. If its bytes cannot be
    // removed, its row stays so they are still found and can be deleted later.
    await source.remove(copy.path);
    await prisma.recoveryPointCopy.delete({ where: { id: copy.id } });
    return landed;
}

async function moveCopies(
    from: DestinationRow,
    to: DestinationRow,
    ownerId: string
): Promise<{ moved: number; bytes: number; failures: string[] }> {
    const source = await openDestination(from, ownerId);
    let target: DestinationHandle | null = null;
    let moved = 0;
    let bytes = 0;
    const failures: string[] = [];
    let inARow = 0;
    let after: string | undefined;
    try {
        target = await openDestination(to, ownerId);
        copies: for (;;) {
            const batch = await prisma.recoveryPointCopy.findMany({
                where: {
                    destinationId: from.id,
                    status: "available",
                    ...(after === undefined ? {} : { id: { gt: after } })
                },
                orderBy: { id: "asc" },
                take: MOVE_BATCH,
                select: { id: true, pointId: true, path: true, sizeBytes: true, sealedWith: true }
            });
            if (batch.length === 0) break;
            for (const copy of batch) {
                after = copy.id;
                try {
                    bytes += await moveOneCopy(copy, source, target, to.id);
                    moved += 1;
                    inARow = 0;
                } catch (error) {
                    failures.push(`${copy.path}: ${reasonOf(error)}`);
                    inARow += 1;
                    if (inARow >= MAX_FAILURES_IN_A_ROW) break copies;
                }
            }
        }
    } finally {
        await source.dispose().catch(() => undefined);
        await target?.dispose().catch(() => undefined);
    }
    return { moved, bytes, failures };
}
