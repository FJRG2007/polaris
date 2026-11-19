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
