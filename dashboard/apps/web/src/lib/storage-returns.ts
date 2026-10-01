/**
 * Files kept on this server while their storage was away, taken back to it.
 *
 * When the storage an upload is meant for does not answer, the upload lands on
 * the disk Polaris runs on instead (`placeFile` / `streamFile`), and each row
 * records where it actually went. That keeps the file readable - and leaves it
 * on the wrong disk for good, quietly filling the one disk that has no room or
 * backups, long after the NAS came back.
 *
 * So each such file is listed (`StorageFallbackFile`) and, once its storage
 * answers again, moved:
 *
 * 1. copied to the same path on the storage, hashed on the way;
 * 2. read back from the storage and hashed again - a write that "succeeded" into
 *    nothing is the failure this whole area keeps meeting;
 * 3. every row that points at this server's copy is repointed at the storage, in
 *    one transaction;
 * 4. this server's copy is removed - a few minutes later, not at once, so a
 *    reader that loaded the old row a moment before still finds the bytes.
 *
 * Each step is idempotent and the list is rows, so a restart at any point
 * resumes: a copy is simply made again, a repoint that already happened finds
 * nothing left to change.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import { createHash } from "node:crypto";
import { dirname } from "node:path/posix";
import { withTimeout } from "@polaris/core";
import type { StorageDriver } from "@polaris/storage";
import { driverForTarget, LOCAL_TARGET } from "@/lib/storage-target";

/** A transaction or the client: what repointing needs. */
type Db = Pick<
    typeof prisma,
    | "userAvatar"
    | "userBanner"
    | "organizationAvatar"
    | "organizationBanner"
    | "chatSpaceAvatar"
    | "chatChannelAvatar"
    | "chatAttachment"
    | "chatUpload"
    | "chatScheduledFile"
    | "meetingAttachment"
    | "chatReportFile"
    | "taskAttachment"
    | "mailUpload"
    | "mailAttachment"
>;

/**
 * For each folder an upload can fall back into, every kind of row that can point
 * at a file in it, repointed from this server to `to`. Returns how many rows
 * now point there.
 *
 * Only rows that still say "this server" (`connectionId: null`) at exactly this
 * path are touched, so nothing written since - a newer photo, a file that moved
 * some other way - is ever pointed at bytes that are not its own.
 */
const REPOINT: Record<string, (db: Db, path: string, to: string) => Promise<number>> = {
    avatars: async (db, path, to) => {
        const where = { connectionId: null, path };
        const data = { connectionId: to };
        const counts = await Promise.all([
            db.userAvatar.updateMany({ where, data }),
            db.userBanner.updateMany({ where, data }),
            db.organizationAvatar.updateMany({ where, data }),
            db.organizationBanner.updateMany({ where, data }),
            db.chatSpaceAvatar.updateMany({ where, data }),
            db.chatChannelAvatar.updateMany({ where, data })
        ]);
        return total(counts);
    },
    chat: async (db, path, to) => {
        const where = { connectionId: null, path };
        const data = { connectionId: to };
        const poster = {
            where: { posterConnectionId: null, posterPath: path },
            data: { posterConnectionId: to }
        };
        const counts = await Promise.all([
            db.chatAttachment.updateMany({ where, data }),
            db.chatAttachment.updateMany(poster),
            db.chatUpload.updateMany({ where, data }),
            db.chatScheduledFile.updateMany({ where, data }),
            db.chatScheduledFile.updateMany(poster),
            db.meetingAttachment.updateMany({ where, data }),
            db.chatReportFile.updateMany({ where, data })
        ]);
        return total(counts);
    },
    uploads: async (db, path, to) =>
        (
            await db.taskAttachment.updateMany({
                where: { connectionId: null, path },
                data: { connectionId: to }
            })
        ).count,
    mail: async (db, path, to) => {
        const where = { connectionId: null, path };
        const data = { connectionId: to };
        const counts = await Promise.all([
            db.mailUpload.updateMany({ where, data }),
            db.mailAttachment.updateMany({ where, data })
        ]);
        return total(counts);
    }
};

function total(counts: readonly { count: number }[]): number {
    return counts.reduce((sum, one) => sum + one.count, 0);
}

/** Whether files falling back into this folder can be taken back. A folder
 *  nobody here knows the rows of is left alone: moving bytes whose rows cannot
 *  be repointed would only strand them. */
export function canReturn(localFolder: string): boolean {
    return Object.hasOwn(REPOINT, localFolder);
}

/**
 * Note a file that was meant for `targetId` and is on this server instead.
 *
 * Never throws: the upload already succeeded, and a file that is not listed only
 * stays where it is - which is where it would be without any of this.
 */
export async function recordFallback(
    targetId: string,
    localFolder: string,
    path: string
): Promise<void> {
    if (targetId === LOCAL_TARGET || !canReturn(localFolder)) return;
    try {
        await prisma.storageFallbackFile.upsert({
            where: { localFolder_path: { localFolder, path } },
            create: { targetId, localFolder, path },
            update: { targetId, movedAt: null }
        });
    } catch (error) {
        console.error(`storage: could not list ${localFolder}/${path} to move back later:`, error);
    }
}

/** A file is left alone this long after it lands, so the row that will point at
 *  it - written by the caller once the upload returns - is there to repoint. */
const SETTLE_MS = 2 * 60 * 1000;

/** How long this server keeps its copy after the rows moved. */
const KEEP_LOCAL_MS = 5 * 60 * 1000;

/** How many files one pass takes on. The rest wait for the next pass. */
const BATCH = 200;

/** Past this many attempts a file is given up on and stays on this server,
 *  still readable. */
const MAX_ATTEMPTS = 20;

/** How long opening a storage may take before a pass gives up on it. */
const OPEN_TIMEOUT_MS = 20_000;

/** How long one file may go without a byte moving. */
const STALL_MS = 60_000;

export interface ReturnResult {
    readonly moved: number;
    readonly removed: number;
    readonly failed: number;
}

let running: Promise<ReturnResult> | null = null;

/**
 * One pass: remove this server's copies of files moved a while ago, then move
 * what is waiting for every storage that answers. `only` narrows it to one
 * storage, for the moment it is found again.
 *
 * One pass at a time in this process; a second replica is kept off each file by
 * claiming it before touching it.
 */
export function returnFallbackFiles(options: { only?: string } = {}): Promise<ReturnResult> {
    running ??= pass(options.only).finally(() => {
        running = null;
    });
    return running;
}

async function pass(only: string | undefined): Promise<ReturnResult> {
    const removed = await removeMovedCopies();
    let moved = 0;
    let failed = 0;

    const waiting = await prisma.storageFallbackFile.findMany({
        where: {
            movedAt: null,
            attempts: { lt: MAX_ATTEMPTS },
            createdAt: { lt: new Date(Date.now() - SETTLE_MS) },
            ...(only ? { targetId: only } : {})
        },
        orderBy: { createdAt: "asc" },
        take: BATCH
    });

    const byTarget = new Map<string, typeof waiting>();
    for (const row of waiting)
        byTarget.set(row.targetId, [...(byTarget.get(row.targetId) ?? []), row]);

    for (const [targetId, rows] of byTarget) {
        const exists = await prisma.storageConnection.findUnique({
            where: { id: targetId },
            select: { id: true }
        });
        if (!exists) {
            // The storage was deleted. Its files stay here, where their rows
            // already point; there is nowhere left to take them.
            await prisma.storageFallbackFile.deleteMany({ where: { targetId } });
            continue;
        }
        const remote = await openWithin(targetId, rows[0]!.localFolder);
        // Still not answering: nothing to do until it does.
        if (!remote) continue;
        try {
            for (const row of rows) {
                const result = await moveOne(remote, row);
                if (result === "moved") moved += 1;
                if (result === "failed") failed += 1;
                if (result === "unreachable") break;
            }
        } finally {
            await remote.dispose().catch(() => undefined);
        }
    }
    if (moved > 0 || failed > 0) {
        console.info(
            `storage: moved ${moved} file(s) kept on this server back to their storage, ${failed} failed`
        );
    }
    return { moved, removed, failed };
}

async function openWithin(targetId: string, localFolder: string): Promise<StorageDriver | null> {
    const opening = driverForTarget(targetId, localFolder);
    try {
        return await withTimeout(opening, OPEN_TIMEOUT_MS, "it did not answer in time");
    } catch {
        void opening.then((late) => late.dispose()).catch(() => undefined);
        return null;
    }
}

type Waiting = {
    id: string;
    targetId: string;
    localFolder: string;
    path: string;
    attempts: number;
};

/** Move one file, or say why it did not move. */
async function moveOne(
    remote: StorageDriver,
    row: Waiting
): Promise<"moved" | "dropped" | "failed" | "unreachable" | "skipped"> {
    // Claimed by bumping its attempt count from what was read: a second replica
    // holding the same row reads a different count and leaves it alone.
    const claimed = await prisma.storageFallbackFile.updateMany({
        where: { id: row.id, attempts: row.attempts, movedAt: null },
        data: { attempts: { increment: 1 } }
    });
    if (claimed.count === 0) return "skipped";

    const local = await driverForTarget(LOCAL_TARGET, row.localFolder);
    try {
        let size: bigint;
        try {
            size = (await local.stat(row.path)).size;
        } catch {
            // Gone from here: deleted along with its row, which is the end of it.
            await prisma.storageFallbackFile
                .delete({ where: { id: row.id } })
                .catch(() => undefined);
            return "dropped";
        }

        try {
            await withTimeout(
                remote.mkdir(dirname(row.path)).catch(() => undefined),
                STALL_MS,
                "mkdir"
            );
            const sent = createHash("sha256");
            const written = await withTimeout(
                remote.writeStream(row.path, hashing(await local.readStream(row.path), sent), {
                    size
                }),
                // Generous: a file is copied whole, and a video over a home LAN
                // can take minutes. What this catches is a storage that stopped.
                Math.max(STALL_MS, Number(size / 1_000_000n) * 1_000 + STALL_MS),
                "it stopped answering part-way through the file"
            );
            if (written.size !== size) throw new Error(`it kept ${written.size} bytes of ${size}`);
            const kept = createHash("sha256");
            await drain(hashing(await remote.readStream(row.path), kept));
            if (kept.digest("hex") !== sent.digest("hex")) {
                throw new Error("what it gave back is not what it was given");
            }
        } catch (error) {
            await remote.delete(row.path, { recursive: false }).catch(() => undefined);
            const unreachable =
                /EHOSTUNREACH|EHOSTDOWN|ETIMEDOUT|ECONNRESET|stopped answering|did not answer/i.test(
                    String(error instanceof Error ? error.message : error)
                );
            await note(row.id, error, unreachable);
            return unreachable ? "unreachable" : "failed";
        }

        const repointed = await prisma.$transaction((tx) =>
            REPOINT[row.localFolder]!(tx, row.path, row.targetId)
        );
        if (repointed === 0) {
            // Nothing points at it any more: its owner deleted it meanwhile, or the
            // upload never got as far as its row. The copy just made is nobody's.
            await remote.delete(row.path, { recursive: false }).catch(() => undefined);
            await prisma.storageFallbackFile
                .delete({ where: { id: row.id } })
                .catch(() => undefined);
            return "dropped";
        }
        await prisma.storageFallbackFile.update({
            where: { id: row.id },
            data: { movedAt: new Date(), lastError: null }
        });
        return "moved";
    } finally {
        await local.dispose().catch(() => undefined);
    }
}

/** This server's copies of files moved a while ago, removed. */
async function removeMovedCopies(): Promise<number> {
    const done = await prisma.storageFallbackFile.findMany({
        where: { movedAt: { lt: new Date(Date.now() - KEEP_LOCAL_MS) } },
        take: BATCH
    });
    let removed = 0;
    for (const row of done) {
        // Every path here is a fresh uuid, so once the rows moved nothing else
        // can be pointing at this copy.
        const local = await driverForTarget(LOCAL_TARGET, row.localFolder).catch(() => null);
        await local?.delete(row.path, { recursive: false }).catch(() => undefined);
        await local?.dispose().catch(() => undefined);
        await prisma.storageFallbackFile.delete({ where: { id: row.id } }).catch(() => undefined);
        removed += 1;
    }
    return removed;
}

async function note(id: string, error: unknown, unreachable: boolean): Promise<void> {
    const text = (error instanceof Error ? error.message : String(error)).slice(0, 500);
    await prisma.storageFallbackFile
        .update({
            where: { id },
            data: { lastError: text, ...(unreachable ? { attempts: { decrement: 1 } } : {}) }
        })
        .catch(() => undefined);
}

/** A stream that feeds every chunk it passes through into a hash. */
function hashing(
    source: ReadableStream<Uint8Array>,
    hash: ReturnType<typeof createHash>
): ReadableStream<Uint8Array> {
    return source.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
                hash.update(chunk);
                controller.enqueue(chunk);
            }
        })
    );
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader();
    for (;;) {
        const { done } = await withTimeout(
            reader.read(),
            STALL_MS,
            "it stopped answering while reading back"
        );
        if (done) return;
    }
}
