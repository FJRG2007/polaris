/**
 * Photos and videos sent to be seen once.
 *
 * What makes it "once" is the server, not a screen: the bytes and the still are
 * refused to everything except the Polaris phone app, and to the app only
 * against a fresh challenge signed with a key that phone made in its own
 * keystore and registered for this account. The open is written before a byte
 * is sent, and the row's primary key refuses the second one. The phone draws it
 * in a window Android keeps out of screenshots and recordings.
 *
 * What it cannot stop, and does not claim to: a camera pointed at the screen,
 * or somebody who builds their own client that signs with a key of its own.
 * The name and the time drawn across the picture are for the first of those.
 *
 * Server-only.
 */

import { Prisma, prisma } from "@polaris/db";
import { removeStoredFiles } from "@/lib/chat/attachments";
import { keepForReports } from "@/lib/chat/report-files";
import {
    deviceChallenge,
    DeviceProofRefused,
    deviceUsed,
    proveDevice,
    type DeviceProof
} from "@/lib/mobile/device-proof";

export type ViewOnceRefusal =
    | "notFound"
    | "own"
    | "opened"
    | "device"
    | "challenge"
    | "signature";

export class ViewOnceRefused extends Error {
    constructor(readonly reason: ViewOnceRefusal) {
        super(`view once refused: ${reason}`);
        this.name = "ViewOnceRefused";
    }
}

/**
 * What a view-once file's `path` becomes once its bytes are gone: the message
 * still says a photo was sent and who opened it, and nothing is left to serve.
 * A path no upload is ever written at - they are all under a channel's folder.
 */
export const VIEW_ONCE_SPENT = "view-once-spent";

/** How long an unopened view-once file waits, as WhatsApp's do. */
export const VIEW_ONCE_KEEP_MS = 14 * 24 * 60 * 60 * 1000;

/** How far back the sweep looks past the wait: a server down for longer than
 *  this leaves the oldest to the next deletion of their message. Keeps the
 *  sweep a bounded range of one index instead of every view-once file ever. */
const SWEEP_WINDOW_MS = 60 * 24 * 60 * 60 * 1000;
const SWEEP_BATCH = 200;

/** Whether a view-once file's bytes are gone. */
export function viewOnceSpent(path: string): boolean {
    return path === VIEW_ONCE_SPENT;
}

/**
 * Take the bytes and the still of view-once files off their storage and mark
 * the rows spent. The mark goes first, so nothing streams a file half deleted;
 * a removal that fails leaves a file nothing points at, which is the outcome to
 * prefer over one somebody could still open. Anything a report holds is moved
 * out from under it first, as deleting a message does.
 */
export async function purgeViewOnce(attachmentIds: readonly string[]): Promise<number> {
    if (attachmentIds.length === 0) return 0;
    const rows = await prisma.chatAttachment.findMany({
        where: { id: { in: [...attachmentIds] }, viewOnce: true, path: { not: VIEW_ONCE_SPENT } },
        select: { id: true, connectionId: true, path: true, posterPath: true, posterConnectionId: true }
    });
    if (rows.length === 0) return 0;
    // Where the bytes are, read before the rows stop saying.
    const files = [
        ...rows.map((row) => ({ connectionId: row.connectionId, path: row.path })),
        ...rows
            .filter((row) => row.posterPath)
            .map((row) => ({ connectionId: row.posterConnectionId, path: row.posterPath! }))
    ];
    await keepForReports(rows.map((row) => row.id));
    await prisma.chatAttachment.updateMany({
        where: { id: { in: rows.map((row) => row.id) }, path: { not: VIEW_ONCE_SPENT } },
        data: { path: VIEW_ONCE_SPENT, posterPath: null, posterConnectionId: null }
    });
    await removeStoredFiles(files).catch((error: unknown) => console.error("polaris: a view-once file could not be removed:", error));
    return rows.length;
}

/**
 * Purge a view-once file once nobody is left to open it: in a direct message
 * or a group, every member but the sender has had their look. A channel in a
 * space has no fixed list of readers, so its files wait for the sweep.
 */
export async function purgeIfSpent(file: ViewOnceFile): Promise<boolean> {
    const channel = await prisma.chatChannel.findUnique({
        where: { id: file.message.channelId },
        select: { kind: true }
    });
    if (channel?.kind !== "dm" && channel?.kind !== "group") return false;
    const opened = await prisma.chatAttachmentOpen.findMany({
        where: { attachmentId: file.id },
        select: { userId: true }
    });
    const waiting = await prisma.chatChannelMember.count({
        where: {
            channelId: file.message.channelId,
            userId: { notIn: [file.message.authorId, ...opened.map((open) => open.userId)].filter(Boolean) as string[] }
        }
    });
    if (waiting > 0) return false;
    return (await purgeViewOnce([file.id])) > 0;
}

/** The scheduled half: everything past its wait, opened or not, in batches. */
export async function sweepViewOnce(now = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - VIEW_ONCE_KEEP_MS);
    const floor = new Date(cutoff.getTime() - SWEEP_WINDOW_MS);
    let purged = 0;
    for (;;) {
        const due = await prisma.chatAttachment.findMany({
            where: {
                viewOnce: true,
                createdAt: { gte: floor, lt: cutoff },
                path: { not: VIEW_ONCE_SPENT }
            },
            select: { id: true },
            take: SWEEP_BATCH
        });
        if (due.length === 0) return purged;
        const done = await purgeViewOnce(due.map((row) => row.id));
        purged += done;
        if (done === 0 || due.length < SWEEP_BATCH) return purged;
    }
}

/** A challenge to open one view-once file, for one reader. */
export function viewOnceChallenge(attachmentId: string, userId: string): string {
    return deviceChallenge("view-once", attachmentId, userId);
}

/** A view-once file as the opening route needs it. Null for anything else. */
export async function viewOnceFile(attachmentId: string) {
    return prisma.chatAttachment.findFirst({
        where: { id: attachmentId, viewOnce: true },
        select: {
            id: true,
            name: true,
            contentType: true,
            connectionId: true,
            path: true,
            viewSeconds: true,
            message: { select: { id: true, channelId: true, authorId: true } }
        }
    });
}

export type ViewOnceFile = NonNullable<Awaited<ReturnType<typeof viewOnceFile>>>;

/**
 * Prove the open and record it, in that order and before any byte is read.
 *
 * Access to the conversation is the caller's to check first; this is the part
 * that makes it once and makes it a phone.
 */
export async function claimViewOnce(
    userId: string,
    file: ViewOnceFile,
    proof: DeviceProof
): Promise<void> {
    if (file.message.authorId === userId) throw new ViewOnceRefused("own");
    let keyId: string;
    try {
        keyId = await proveDevice(userId, "view-once", file.id, proof);
    } catch (error) {
        if (error instanceof DeviceProofRefused) throw new ViewOnceRefused(error.reason);
        throw error;
    }
    try {
        await prisma.chatAttachmentOpen.create({ data: { attachmentId: file.id, userId } });
    } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
            throw new ViewOnceRefused("opened");
        }
        throw error;
    }
    await deviceUsed(keyId);
}

/** Who is looking and when, for the phone to draw across the picture. */
export function watermarkText(name: string, at = new Date()): string {
    const stamp = at.toISOString().slice(0, 16).replace("T", " ");
    return `${name} - ${stamp} UTC`.slice(0, 120);
}
