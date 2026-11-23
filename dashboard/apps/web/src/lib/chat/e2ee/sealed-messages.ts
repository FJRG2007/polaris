/**
 * Sealed chat messages on the server (docs/chat-e2ee-mls.md): it stores what a
 * device sealed and hands it back, and never sees the content.
 *
 * Taking one: the device is the session's own, the conversation's group
 * exists and is at least at the message's epoch (a key from an epoch that has
 * not happened yet is a forgery or a fork), and the device's signature
 * verifies under the signature key the server holds for it - so the row
 * cannot claim another device, account or message. That key is copied onto
 * the row, which is what a reader checks the signature against later, after
 * the device may have registered a new one. The message itself goes through
 * the ordinary `send`, with an empty body: every rule about who may post
 * where still applies, and nothing that reads a body (previews, mentions,
 * link cards, commands, search) has anything to read.
 *
 * Reading: only messages the account may see - in a conversation it reaches,
 * not deleted, not past their expiry, not another reader's ephemeral answer.
 */

import { prisma } from "@polaris/db";
import * as messages from "@/lib/chat/messages";
import * as content from "@polaris/chat-crypto/message-content";

export const MAX_SEALED_READ = 100;

/** What a device sends for one sealed message (validated by `mlsBody`). */
export interface SealedSend {
    channelId: string;
    device: string;
    /** The message id the content is bound to, and the send's idempotency key. */
    clientKey: string;
    parentId?: string | null;
    epoch: bigint;
    senderLeaf: number;
    ciphertext: Uint8Array;
    signature: Uint8Array;
}

/** Why a sealed message was not taken; the route answers it as a refusal. */
export class SealedRefusal extends Error {
    constructor(readonly reason: "unknownDevice" | "unknownGroup" | "futureEpoch" | "badSignature") {
        super(`the sealed message was refused (${reason})`);
        this.name = "SealedRefusal";
    }
}

const owned = (value: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(value);

/** Store one sealed message for `userId`; answers the message id (the stored one on a repeat). */
export async function sendSealed(userId: string, input: SealedSend): Promise<string> {
    const [device, group] = await Promise.all([
        prisma.mlsDevice.findUnique({ where: { userId_device: { userId, device: input.device } }, select: { signatureKey: true } }),
        prisma.mlsGroup.findUnique({ where: { channelId: input.channelId }, select: { epoch: true } })
    ]);
    if (!device) throw new SealedRefusal("unknownDevice");
    if (!group) throw new SealedRefusal("unknownGroup");
    if (input.epoch > group.epoch) throw new SealedRefusal("futureEpoch");
    const binding = { conversationId: input.channelId, epoch: input.epoch, messageId: input.clientKey, senderLeaf: input.senderLeaf };
    const signatureKey = new Uint8Array(device.signatureKey);
    if (!(await content.verifyMessageSignature(signatureKey, binding, input.ciphertext, input.signature))) throw new SealedRefusal("badSignature");
    return messages.send(
        { id: userId },
        { channelId: input.channelId, body: "", clientKey: input.clientKey, parentId: input.parentId ?? null },
        [],
        null,
        null,
        null,
        null,
        {
            e2eeCiphertext: owned(input.ciphertext),
            e2eeEpoch: input.epoch,
            e2eeSenderLeaf: input.senderLeaf,
            e2eeDevice: input.device,
            e2eeSignature: owned(input.signature),
            e2eeSignatureKey: owned(signatureKey)
        }
    );
}

/** One stored sealed message, as a reader opens it. */
export interface SealedRow {
    id: string;
    authorId: string | null;
    clientKey: string;
    device: string;
    epoch: bigint;
    senderLeaf: number;
    ciphertext: Uint8Array;
    signature: Uint8Array;
    signatureKey: Uint8Array;
}

/**
 * The sealed content of these messages that `userId` may see, in a
 * conversation the caller already checked it reaches. Messages that are not
 * sealed, or not visible to it, are left out.
 */
export async function readSealed(userId: string, channelId: string, ids: readonly string[]): Promise<SealedRow[]> {
    const wanted = [...new Set(ids)].slice(0, MAX_SEALED_READ);
    if (!wanted.length) return [];
    const rows = await prisma.chatMessage.findMany({
        where: { channelId, id: { in: wanted }, deletedAt: null },
        select: {
            id: true,
            authorId: true,
            clientKey: true,
            expiresAt: true,
            audience: true,
            e2eeCiphertext: true,
            e2eeEpoch: true,
            e2eeSenderLeaf: true,
            e2eeDevice: true,
            e2eeSignature: true,
            e2eeSignatureKey: true
        },
        take: MAX_SEALED_READ
    });
    const now = Date.now();
    return rows.flatMap((row) => {
        const visible = (!row.expiresAt || row.expiresAt.getTime() > now) && (!row.audience?.length || row.audience.includes(userId));
        const { clientKey, e2eeCiphertext, e2eeEpoch, e2eeSenderLeaf, e2eeDevice, e2eeSignature, e2eeSignatureKey } = row;
        if (!visible || !clientKey || !e2eeCiphertext || e2eeEpoch == null || e2eeSenderLeaf == null || !e2eeDevice || !e2eeSignature || !e2eeSignatureKey)
            return [];
        return [
            {
                id: row.id,
                authorId: row.authorId,
                clientKey,
                device: e2eeDevice,
                epoch: e2eeEpoch,
                senderLeaf: e2eeSenderLeaf,
                ciphertext: new Uint8Array(e2eeCiphertext),
                signature: new Uint8Array(e2eeSignature),
                signatureKey: new Uint8Array(e2eeSignatureKey)
            }
        ];
    });
}
