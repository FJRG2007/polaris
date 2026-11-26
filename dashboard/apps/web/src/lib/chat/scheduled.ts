/**
 * Messages written now and sent later.
 *
 * A scheduled message is deliberately not a message. Nothing about it is in the
 * conversation, nothing counts it as unread, nobody is notified, and taking it
 * back leaves no trace - the room hears about it at the moment it is sent and
 * not a second before. That is the difference between this and a draft that
 * posts itself, and it is why the row lives in a table of its own rather than as
 * a message with a flag on it: a flag would have to be honoured by every read
 * path in the app, and the day one of them forgot, somebody's unsent message
 * would appear in a room.
 *
 * Two things are settled twice on purpose. Whether the writer may post here is
 * checked when they schedule it AND again when it goes, because the hours in
 * between are exactly when somebody is removed from a room or timed out in it -
 * and a message that lands from somebody who was shown the door is worse than
 * one that never arrives. Whether the room still exists is the same question.
 *
 * The files are written at the moment it is scheduled. They are on the machine
 * that wrote them, and a laptop closed overnight takes them with it - so the
 * bytes go to storage now and what is kept here is exactly what an attachment
 * row keeps, which makes sending the same call the live path makes.
 *
 * In a sealed conversation the message is sealed in the writer's browser when
 * it is scheduled (docs/chat-e2ee-mls.md, "Sealed scheduled messages"): the
 * row keeps what `send-sealed` would take and an empty body, its sealed files
 * are claimed at once, and it goes through `sendSealed`. It goes only while the
 * conversation is still at the epoch it was sealed in - after a member is
 * removed, a key they hold must not seal anything new - and the writer's
 * device seals it again at the new epoch whenever it opens the conversation.
 *
 * Server-only.
 */

import { refusePlainIfSealed, send } from "./messages";
import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { removeStoredFiles, type StoredAttachment } from "./attachments";
import { refuseRoomMention } from "./room-mentions";
import { ChatAccessError, requirePostable, type ChatActor } from "./access";
import * as sealed from "./e2ee/sealed-messages";

/** One waiting message, as the screen that lists them draws it. */
export interface ScheduledMessageView {
    readonly id: string;
    readonly channelId: string;
    readonly body: string;
    readonly sendAt: string;
    /** What it carries, named so the list can say "2 files" rather than a count
     *  of nothing in particular. */
    readonly files: readonly { readonly name: string; readonly contentType: string }[];
    /** Whether it answers something, which is why it may read oddly on its own. */
    readonly replying: boolean;
    /** Why it did not go, for one the sweep could not send. Null for everything
     *  still waiting, which is nearly all of them. */
    readonly failure: string | null;
    /** A sealed one: what its writer's device opens it from (`body` is empty), the
     *  fields of `SealedStored`. Null when the device that sealed it is gone. */
    readonly sealed?: ScheduledSeal | null;
    /** A sealed one whose conversation has moved past the epoch it was sealed in:
     *  it does not go until the writer's device seals it again. */
    readonly resealDue?: boolean;
}

/** A sealed scheduled message as its writer's device opens it (base64url fields). */
export interface ScheduledSeal {
    readonly clientKey: string;
    readonly device: string;
    readonly epoch: string;
    readonly senderLeaf: number;
    readonly ciphertext: string;
    readonly signature: string;
    readonly signatureKey: string;
}

const text = (value: Uint8Array) => Buffer.from(value).toString("base64url");

interface ListedRow {
    id: string;
    channelId: string;
    body: string;
    sendAt: Date;
    replyToId: string | null;
    failure: string | null;
    clientKey: string | null;
    e2eeCiphertext: Uint8Array | null;
    e2eeEpoch: bigint | null;
    e2eeSenderLeaf: number | null;
    e2eeDevice: string | null;
    e2eeSignature: Uint8Array | null;
    files: { name: string; contentType: string }[];
}

function view(row: ListedRow, signatureKeys: ReadonlyMap<string, Uint8Array>, groupEpoch: bigint | null): ScheduledMessageView {
    const base = {
        id: row.id,
        channelId: row.channelId,
        body: row.body,
        sendAt: row.sendAt.toISOString(),
        files: row.files.map((file) => ({ name: file.name, contentType: file.contentType })),
        replying: row.replyToId !== null,
        failure: row.failure
    };
    if (row.e2eeCiphertext === null || row.e2eeEpoch === null || !row.clientKey || !row.e2eeDevice || !row.e2eeSignature || row.e2eeSenderLeaf === null) return base;
    const signatureKey = signatureKeys.get(row.e2eeDevice);
    return {
        ...base,
        sealed: signatureKey
            ? {
                  clientKey: row.clientKey,
                  device: row.e2eeDevice,
                  epoch: row.e2eeEpoch.toString(),
                  senderLeaf: row.e2eeSenderLeaf,
                  ciphertext: text(row.e2eeCiphertext),
                  signature: text(row.e2eeSignature),
                  signatureKey: text(signatureKey)
              }
            : null,
        resealDue: groupEpoch !== null && row.e2eeEpoch !== groupEpoch
    };
}

/**
 * Write one down for later.
 *
 * The files have already been stored by the caller - the route that took them -
 * so this is the row and nothing else. A refusal here is the caller's to clean
 * up after, the same way it is when a live message fails to send.
 */
export async function scheduleMessage(
    actor: ChatActor,
    input: core.ChatScheduleInput,
    attachments: readonly StoredAttachment[] = []
): Promise<string> {
    const access = await requirePostable(actor, input.channelId);
    // A scheduled message is stored in the clear until it goes: refused now in
    // a sealed conversation rather than when it fails to go.
    await refusePlainIfSealed(input.channelId);
    // Said now rather than discovered when it fails to go. Asked again then as
    // well, through `send`: the owner may close it in between.
    await refuseRoomMention(actor, access, input.body);

    const sendAt = new Date(input.sendAt);
    const problem = core.scheduleProblem(sendAt);
    if (problem) throw new ChatAccessError({ key: `errors.schedule.${problem}` });
    if (attachments.length === 0 && !input.body.trim()) {
        throw new ChatAccessError({ key: "errors.bodyRequired" });
    }

    const row = await prisma.chatScheduledMessage.create({
        data: {
            channelId: input.channelId,
            authorId: actor.id,
            body: input.body,
            parentId: input.parentId ?? null,
            replyToId: input.replyToId ?? null,
            forwarded: input.forwarded,
            sendAt,
            files: {
                create: attachments.map((file) => ({
                    name: file.name,
                    size: BigInt(file.size),
                    contentType: file.contentType,
                    connectionId: file.connectionId,
                    path: file.path,
                    durationMs: file.durationMs,
                    waveform: file.waveform,
                    posterPath: file.posterPath,
                    posterConnectionId: file.posterConnectionId,
                    // Both were read back when it was sent and never written, so
                    // a covered file arrived uncovered and a Drive file arrived
                    // as a copy the cancel path would delete.
                    spoiler: file.spoiler,
                    borrowed: file.borrowed,
                    // Kept so it arrives at its final size, the way one sent
                    // now does - see `lib/chat/media-shape`.
                    width: file.width ?? null,
                    height: file.height ?? null,
                    thumbhash: file.thumbhash ?? null
                }))
            }
        },
        select: { id: true }
    });
    return row.id;
}

/**
 * What this person has waiting in this conversation.
 *
 * Theirs only, and that is not a scope decision but the whole privacy of the
 * feature: a message nobody has sent yet belongs to the person writing it, and a
 * room where anybody could read what is coming would be a room nobody schedules
 * anything in.
 */
export async function listScheduled(
    actor: ChatActor,
    channelId: string
): Promise<ScheduledMessageView[]> {
    const rows = await prisma.chatScheduledMessage.findMany({
        where: { channelId, authorId: actor.id },
        orderBy: { sendAt: "asc" },
        select: {
            id: true,
            channelId: true,
            body: true,
            sendAt: true,
            replyToId: true,
            failure: true,
            clientKey: true,
            e2eeCiphertext: true,
            e2eeEpoch: true,
            e2eeSenderLeaf: true,
            e2eeDevice: true,
            e2eeSignature: true,
            files: { select: { name: true, contentType: true } }
        }
    });
    const devices = [...new Set(rows.flatMap((row) => (row.e2eeDevice ? [row.e2eeDevice] : [])))];
    if (!devices.length) return rows.map((row) => view(row, new Map(), null));
    // The writer's own devices only: the key a seal verifies under, as `read-sealed` hands it.
    const [keys, group] = await Promise.all([
        prisma.mlsDevice.findMany({ where: { userId: actor.id, device: { in: devices } }, select: { device: true, signatureKey: true } }),
        prisma.mlsGroup.findUnique({ where: { channelId }, select: { epoch: true } })
    ]);
    const signatureKeys = new Map(keys.map((key) => [key.device, new Uint8Array(key.signatureKey)]));
    return rows.map((row) => view(row, signatureKeys, group?.epoch ?? null));
}

/** What a device sealed for a message it schedules (validated by `mlsBody`, op `schedule-sealed`). */
export interface SealedSchedule extends sealed.SealedSeal {
    parentId?: string | null;
    replyToId?: string | null;
    /** Sealed files staged for it; claimed now, sent with it. */
    uploads?: readonly string[];
    sendAt: string;
}

/**
 * Write a sealed one down for later. The seal is checked as a live sealed send
 * checks it, and at the conversation's current epoch only - the device brought
 * the group up to date before sealing. A repeat with the same `clientKey`
 * answers the row already written.
 */
export async function scheduleSealed(actor: ChatActor, input: SealedSchedule): Promise<string> {
    await requirePostable(actor, input.channelId);
    const sendAt = new Date(input.sendAt);
    const problem = core.scheduleProblem(sendAt);
    if (problem) throw new ChatAccessError({ key: `errors.schedule.${problem}` });
    const already = await prisma.chatScheduledMessage.findFirst({
        where: { channelId: input.channelId, authorId: actor.id, clientKey: input.clientKey },
        select: { id: true }
    });
    if (already) return already.id;
    const { groupEpoch } = await sealed.verifySeal(actor.id, input);
    if (input.epoch !== groupEpoch) throw new sealed.SealedRefusal("olderEpoch");

    const files = input.uploads?.length ? await sealed.sealedFiles(actor.id, input.channelId, input.uploads) : [];
    try {
        const row = await prisma.chatScheduledMessage.create({
            data: {
                channelId: input.channelId,
                authorId: actor.id,
                body: "",
                parentId: input.parentId ?? null,
                replyToId: input.replyToId ?? null,
                sendAt,
                clientKey: input.clientKey,
                e2eeCiphertext: new Uint8Array(input.ciphertext),
                e2eeEpoch: input.epoch,
                e2eeSenderLeaf: input.senderLeaf,
                e2eeDevice: input.device,
                e2eeSignature: new Uint8Array(input.signature),
                files: {
                    create: files.map((file) => ({
                        // The upload's id, which the seal names.
                        ...(file.id ? { id: file.id } : {}),
                        sealed: true,
                        name: file.name,
                        size: BigInt(file.size),
                        contentType: file.contentType,
                        connectionId: file.connectionId,
                        path: file.path
                    }))
                }
            },
            select: { id: true }
        });
        return row.id;
    } catch (caught) {
        // Claimed and then not kept: the bytes would belong to nobody.
        if (files.length) await removeStoredFiles(files).catch((error: unknown) => console.error("chat: sealed scheduled files were not removed:", error));
        throw caught;
    }
}

/** A sealed scheduled message sealed again by its writer's device at the conversation's current epoch. */
export type SealedReseal = Omit<sealed.SealedSeal, "clientKey"> & { id: string };

/**
 * Take the new seal of one of the actor's sealed scheduled messages: the same
 * message id, the conversation's current epoch, no older than the one it
 * replaces. A row the sweep set aside because the epoch moved is waiting
 * again, and goes at the next pass if its hour has passed.
 */
export async function resealScheduled(actor: ChatActor, input: SealedReseal): Promise<void> {
    const row = await prisma.chatScheduledMessage.findFirst({
        where: { id: input.id, authorId: actor.id, channelId: input.channelId },
        select: { id: true, clientKey: true, e2eeEpoch: true }
    });
    if (!row || !row.clientKey || row.e2eeEpoch === null) throw new ChatAccessError({ key: "errors.scheduledMissing" });
    const { groupEpoch } = await sealed.verifySeal(actor.id, { ...input, clientKey: row.clientKey });
    if (input.epoch !== groupEpoch || input.epoch < row.e2eeEpoch) throw new sealed.SealedRefusal("olderEpoch");
    // Only over the seal it was read at: two tabs sealing it again cannot both land.
    await prisma.chatScheduledMessage.updateMany({
        where: { id: row.id, e2eeEpoch: row.e2eeEpoch },
        data: {
            e2eeCiphertext: new Uint8Array(input.ciphertext),
            e2eeEpoch: input.epoch,
            e2eeSenderLeaf: input.senderLeaf,
            e2eeDevice: input.device,
            e2eeSignature: new Uint8Array(input.signature),
            failure: null,
            failedAt: null
        }
    });
}

/** Everything this person has waiting, anywhere. What the rail counts. */
export async function countScheduled(actor: ChatActor): Promise<number> {
    return prisma.chatScheduledMessage.count({ where: { authorId: actor.id } });
}

/**
 * Take one back.
 *
 * The files go with it. They were written when it was scheduled, nothing else
 * points at them, and a cancelled message that left a video on a NAS is a disk
 * that only fills up.
 */
export async function cancelScheduled(actor: ChatActor, id: string): Promise<void> {
    const row = await prisma.chatScheduledMessage.findFirst({
        where: { id, authorId: actor.id },
        select: {
            id: true,
            files: {
                select: {
                    connectionId: true,
                    path: true,
                    posterPath: true,
                    posterConnectionId: true,
                    borrowed: true
                }
            }
        }
    });
    // Silent for one that is not theirs or is already gone: both are "there is
    // nothing waiting under that id", and telling them apart would answer
    // questions about somebody else's messages.
    if (!row) return;

    await prisma.chatScheduledMessage.delete({ where: { id: row.id } });
    // A borrowed file is somebody's own Drive file: cancelling the message does
    // not delete it.
    const ours = row.files.filter((file) => !file.borrowed);
    await removeStoredFiles([
        ...ours,
        // The still goes with the file it is of.
        ...ours
            .filter((file) => file.posterPath)
            .map((file) => ({ connectionId: file.posterConnectionId, path: file.posterPath! }))
    ]);
}

/**
 * Send one now rather than at the hour it was written for.
 *
 * The half of the feature that stops it being a trap: plans change, and a person
 * who has to wait for their own message to be sent - or cancel it, retype it and
 * send it again - is a person who will not schedule the next one.
 */
export async function sendScheduledNow(actor: ChatActor, id: string): Promise<void> {
    const row = await prisma.chatScheduledMessage.findFirst({
        where: { id, authorId: actor.id },
        select: rowForSending
    });
    if (!row) throw new ChatAccessError({ key: "errors.scheduledMissing" });

    await deliver(row);
}

/** Everything sending one needs, in one shape both callers read. */
const rowForSending = {
    id: true,
    channelId: true,
    authorId: true,
    body: true,
    parentId: true,
    replyToId: true,
    forwarded: true,
    clientKey: true,
    e2eeCiphertext: true,
    e2eeEpoch: true,
    e2eeSenderLeaf: true,
    e2eeDevice: true,
    e2eeSignature: true,
    files: {
        select: {
            id: true,
            sealed: true,
            name: true,
            size: true,
            contentType: true,
            connectionId: true,
            path: true,
            durationMs: true,
            waveform: true,
            posterPath: true,
            posterConnectionId: true,
            spoiler: true,
            borrowed: true,
            width: true,
            height: true,
            thumbhash: true
        }
    }
} as const;

interface SendableRow {
    id: string;
    channelId: string;
    authorId: string;
    body: string;
    parentId: string | null;
    replyToId: string | null;
    forwarded: boolean;
    clientKey: string | null;
    e2eeCiphertext: Uint8Array | null;
    e2eeEpoch: bigint | null;
    e2eeSenderLeaf: number | null;
    e2eeDevice: string | null;
    e2eeSignature: Uint8Array | null;
    files: {
        id: string;
        sealed: boolean;
        name: string;
        size: bigint;
        contentType: string;
        connectionId: string | null;
        path: string;
        durationMs: number | null;
        waveform: string | null;
        posterPath: string | null;
        posterConnectionId: string | null;
        spoiler: boolean;
        borrowed: boolean;
        width: number | null;
        height: number | null;
        thumbhash: string | null;
    }[];
}

/**
 * Put one into the room, and take the row away.
 *
 * The row is deleted rather than marked sent, and the files are deliberately not
 * removed with it: they belong to the message now. Marking it would leave a
 * table that only grows, holding the text of every message anybody ever
 * scheduled - a second copy of the conversation, in a place nothing shows and
 * nothing deletes.
 */
async function deliver(row: SendableRow): Promise<void> {
    if (row.e2eeCiphertext !== null) return deliverSealed(row);
    const attachments: StoredAttachment[] = row.files.map((file) => ({
        name: file.name,
        size: Number(file.size),
        contentType: file.contentType,
        connectionId: file.connectionId,
        path: file.path,
        spoiler: file.spoiler,
        borrowed: file.borrowed,
        durationMs: file.durationMs,
        waveform: file.waveform,
        posterPath: file.posterPath,
        posterConnectionId: file.posterConnectionId,
        width: file.width,
        height: file.height,
        thumbhash: file.thumbhash
    }));

    await send(
        { id: row.authorId },
        {
            channelId: row.channelId,
            // A message that is only a file has no body, and the schema behind
            // `send` refuses an empty one. The same space the live path uses.
            body: row.body || " ",
            parentId: row.parentId
        },
        attachments,
        row.replyToId ? { messageId: row.replyToId, forwarded: row.forwarded } : null
    );
    await prisma.chatScheduledMessage.delete({ where: { id: row.id } });
}

/**
 * A sealed one: sent as its writer's device sealed it, through `sendSealed`,
 * with the files claimed when it was scheduled. Only at the epoch it was sealed
 * in: a later epoch means the conversation's keys changed - usually somebody
 * left or was removed - and a key they still hold must not seal a message that
 * appears after they are gone. It waits for the writer's device to seal it
 * again (`resealScheduled`).
 */
async function deliverSealed(row: SendableRow): Promise<void> {
    if (row.e2eeEpoch === null || !row.clientKey || !row.e2eeDevice || !row.e2eeSignature || row.e2eeSenderLeaf === null || row.e2eeCiphertext === null) {
        throw new Error("a sealed scheduled message is missing part of its seal");
    }
    const group = await prisma.mlsGroup.findUnique({ where: { channelId: row.channelId }, select: { epoch: true } });
    if (!group || group.epoch !== row.e2eeEpoch) throw new ChatAccessError({ key: "errors.schedule.sealedKeysChanged" });
    const files: StoredAttachment[] = row.files.map((file) => ({
        id: file.id,
        sealed: true,
        name: file.name,
        size: Number(file.size),
        contentType: file.contentType,
        connectionId: file.connectionId,
        path: file.path,
        spoiler: false,
        borrowed: false,
        durationMs: null,
        waveform: null,
        posterPath: null,
        posterConnectionId: null
    }));
    await sealed.sendSealed(
        row.authorId,
        {
            channelId: row.channelId,
            device: row.e2eeDevice,
            clientKey: row.clientKey,
            parentId: row.parentId,
            replyToId: row.replyToId,
            epoch: row.e2eeEpoch,
            senderLeaf: row.e2eeSenderLeaf,
            ciphertext: new Uint8Array(row.e2eeCiphertext),
            signature: new Uint8Array(row.e2eeSignature)
        },
        files
    );
    await prisma.chatScheduledMessage.delete({ where: { id: row.id } });
}

/**
 * How many are sent in one pass.
 *
 * A bound rather than a limit anybody meets: the sweep runs every minute, and a
 * pass that tried to send ten thousand at once would hold its lease until the
 * next one had already given up on it. Whatever is left is due at the next pass,
 * a minute later.
 */
const PER_PASS = 200;

/**
 * Send everything that has come due.
 *
 * Leased by the scheduler, because sending twice is the one thing this must not
 * do - and the row being deleted on the way out is what makes a second pass over
 * the same message impossible even if a lease is ever lost.
 *
 * A message that cannot be sent is kept and marked rather than dropped: the
 * usual reason is that its author has been timed out or taken out of the room
 * since they wrote it, and the honest outcome is that they still have their
 * words and can see why they never went. It is not retried, for the same reason
 * it is not dropped - retrying a refusal every minute for a year is not a
 * feature.
 */
export async function sweepDueScheduledMessages(): Promise<{ sent: number; failed: number }> {
    const due = await prisma.chatScheduledMessage.findMany({
        where: { sendAt: { lte: new Date() }, failedAt: null },
        orderBy: { sendAt: "asc" },
        take: PER_PASS,
        select: rowForSending
    });

    let sent = 0;
    let failed = 0;
    for (const row of due) {
        try {
            await deliver(row);
            sent += 1;
        } catch (caught) {
            failed += 1;
            const reason =
                caught instanceof ChatAccessError
                    ? caught.message
                    : "Polaris could not send this message";
            // Never the raw error: this line is drawn to whoever wrote the
            // message, and a stack or a storage path is neither theirs nor
            // useful to them. The log has the rest.
            if (!(caught instanceof ChatAccessError)) console.error("scheduled message:", caught);
            await prisma.chatScheduledMessage
                .update({
                    where: { id: row.id },
                    data: { failure: reason, failedAt: new Date() }
                })
                .catch(() => undefined);
        }
    }
    return { sent, failed };
}
