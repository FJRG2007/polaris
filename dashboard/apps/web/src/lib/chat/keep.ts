/**
 * Keep in chat (ledger row 9): somebody keeps a disappearing message so it
 * stays when the timer would have taken it.
 *
 * Prior art: WhatsApp's "Keep in chat" (2023). Anybody who can read a
 * disappearing message may keep it; everybody sees that it was kept and by
 * whom (a line in the conversation); its author may take every keep back and
 * may forbid keeping it at all; a group's owner may keep the choice to
 * whoever runs the group; and the instance may forbid keeping anywhere
 * (`moderation-policy.ts`).
 *
 * How: while a message has at least one keep, its `expiresAt` is cleared and
 * the expiry it had waits in `keptExpiresAt`. Every reader and the sweep
 * already go by `expiresAt` alone, so a kept message is simply a message that
 * does not expire, and nothing else had to learn about keeping. When the last
 * keep goes the expiry is put back; if it has already passed, the message is
 * gone at once for every reader and the next sweep deletes it.
 */

import { prisma } from "@polaris/db";
import { isEphemeral } from "./ephemeral";
import { publishChatChange } from "./live";
import { postNoticeBody } from "./notices";
import { noticeMention } from "./notice-text";
import * as history from "./history-visibility";
import { moderationPolicy } from "./moderation-policy";
import {
    ChatAccessError,
    ChatRuleError,
    channelAccess,
    requireChannel,
    type ChatActor,
    type ChannelAccess
} from "./access";

interface KeepChannel {
    readonly spaceId: string | null;
    readonly ownerId: string | null;
    readonly membersMayKeep: boolean;
}

/** Whether this reader may keep messages in this conversation, by its own
 *  rule. A space channel is run by its administrators, a group by its owner. */
export function mayKeepIn(actorId: string, access: Pick<ChannelAccess, "mayAdminister" | "member">, channel: KeepChannel): boolean {
    if (channel.membersMayKeep) return true;
    return channel.spaceId ? access.mayAdminister : channel.ownerId === actorId;
}

async function whoName(actorId: string): Promise<string> {
    const user = await prisma.user.findUnique({ where: { id: actorId }, select: { name: true } });
    return noticeMention({ id: actorId, name: user?.name ?? "Somebody" });
}

function announce(channelId: string, messageId: string, actorId: string): void {
    publishChatChange({ channelId, kind: "posted", actorId, messageIds: [messageId] });
}

/** Keep one disappearing message. A no-op when this reader already keeps it. */
export async function keepMessage(actor: ChatActor, messageId: string): Promise<void> {
    const message = await prisma.chatMessage.findUnique({
        where: { id: messageId },
        select: {
            channelId: true,
            authorId: true,
            deletedAt: true,
            audience: true,
            expiresAt: true,
            keptExpiresAt: true,
            keepable: true,
            channel: { select: { spaceId: true, ownerId: true, membersMayKeep: true } }
        }
    });
    if (!message) throw new ChatAccessError({ key: "errors.messageGone" });
    const access = await requireChannel(actor, message.channelId);
    await history.requireReadable(actor, message.channelId, messageId);
    const kept = message.keptExpiresAt !== null;
    if (!kept && message.expiresAt === null) throw new ChatRuleError({ key: "errors.keepNotDisappearing" });
    if (message.deletedAt !== null || isEphemeral(message.audience)) {
        throw new ChatRuleError({ key: "errors.keepNotAllowed" });
    }
    if ((await moderationPolicy()).keep === "forbidden" || !message.keepable) {
        throw new ChatRuleError({ key: "errors.keepNotAllowed" });
    }
    if (!mayKeepIn(actor.id, access, message.channel)) {
        throw new ChatAccessError({ key: "errors.keepAdminsOnly" });
    }
    const added = await prisma.$transaction(async (tx) => {
        if (!kept) {
            // Only from the expiry read above: a concurrent keep or a timer
            // change since then makes this match nothing, and the keep row
            // alone is still right.
            await tx.chatMessage.updateMany({
                where: { id: messageId, keptExpiresAt: null, expiresAt: message.expiresAt, keepable: true },
                data: { keptExpiresAt: message.expiresAt, expiresAt: null }
            });
        }
        const row = await tx.chatMessageKeep.createMany({
            data: [{ messageId, userId: actor.id }],
            skipDuplicates: true
        });
        return row.count;
    });
    if (added === 0) return;
    await postNoticeBody(message.channelId, `${await whoName(actor.id)} kept a message`, actor.id);
    announce(message.channelId, messageId, actor.id);
}

/**
 * Stop keeping it. Its author takes back every keep at once; anybody else
 * only their own. When no keep is left the message disappears on its old
 * timer.
 */
export async function unkeepMessage(actor: ChatActor, messageId: string): Promise<void> {
    const message = await prisma.chatMessage.findUnique({
        where: { id: messageId },
        select: { channelId: true, authorId: true }
    });
    if (!message) throw new ChatAccessError({ key: "errors.messageGone" });
    await requireChannel(actor, message.channelId);
    const everybody = message.authorId === actor.id;
    const removed = await releaseKeeps(messageId, everybody ? null : actor.id);
    if (removed === 0) return;
    await postNoticeBody(
        message.channelId,
        everybody
            ? `${await whoName(actor.id)} unkept their message`
            : `${await whoName(actor.id)} unkept a message`,
        actor.id
    );
    announce(message.channelId, messageId, actor.id);
}

/** Its author lets it be kept, or not. Forbidding it takes every keep back. */
export async function setKeepable(actor: ChatActor, messageId: string, keepable: boolean): Promise<void> {
    const message = await prisma.chatMessage.findUnique({
        where: { id: messageId },
        select: { channelId: true, authorId: true }
    });
    if (!message) throw new ChatAccessError({ key: "errors.messageGone" });
    await requireChannel(actor, message.channelId);
    if (message.authorId !== actor.id) throw new ChatAccessError({ key: "errors.keepNotAllowed" });
    const changed = await prisma.chatMessage.updateMany({
        where: { id: messageId, keepable: !keepable },
        data: { keepable }
    });
    if (changed.count === 0) return;
    if (!keepable && (await releaseKeeps(messageId, null)) > 0) {
        await postNoticeBody(message.channelId, `${await whoName(actor.id)} unkept their message`, actor.id);
    }
    announce(message.channelId, messageId, actor.id);
}

/**
 * Remove keeps - one person's, or all of them with `userId` null - and put
 * the expiry back when none is left. One transaction, so a keep added at the
 * same moment either lands before (and is removed with the rest, or keeps it)
 * or after (and finds the message expiring again, and keeps it again).
 */
async function releaseKeeps(messageId: string, userId: string | null): Promise<number> {
    return prisma.$transaction(async (tx) => {
        const gone = await tx.chatMessageKeep.deleteMany({
            where: { messageId, ...(userId ? { userId } : {}) }
        });
        if (gone.count === 0) return 0;
        const left = await tx.chatMessageKeep.count({ where: { messageId } });
        if (left === 0) {
            const row = await tx.chatMessage.findUnique({
                where: { id: messageId },
                select: { keptExpiresAt: true }
            });
            if (row?.keptExpiresAt) {
                await tx.chatMessage.update({
                    where: { id: messageId },
                    data: { expiresAt: row.keptExpiresAt, keptExpiresAt: null }
                });
            }
        }
        return gone.count;
    });
}

/** What the message list needs to draw and offer keeping, in two reads. */
export interface KeepState {
    readonly kept: boolean;
    readonly keptByMe: boolean;
    /** Whether this reader may keep it now. */
    readonly mayKeep: boolean;
}

export async function keepStates(
    actor: ChatActor,
    rows: readonly {
        readonly id: string;
        readonly channelId: string;
        readonly expiresAt: Date | null;
        readonly keptExpiresAt?: Date | null;
        readonly keepable?: boolean;
        readonly deletedAt: Date | null;
        readonly audience: readonly string[];
    }[],
): Promise<Map<string, KeepState>> {
    const out = new Map<string, KeepState>();
    const candidates = rows.filter((row) => row.expiresAt !== null || (row.keptExpiresAt ?? null) !== null);
    if (candidates.length === 0) return out;
    const actorId = actor.id;
    const channelIds = [...new Set(candidates.map((row) => row.channelId))];
    const [policy, mine, channels, accesses] = await Promise.all([
        moderationPolicy(),
        prisma.chatMessageKeep.findMany({
            where: { userId: actorId, messageId: { in: candidates.map((row) => row.id) } },
            select: { messageId: true }
        }),
        prisma.chatChannel.findMany({
            where: { id: { in: channelIds } },
            select: { id: true, spaceId: true, ownerId: true, membersMayKeep: true }
        }),
        Promise.all(channelIds.map(async (id) => [id, await channelAccess(actor, id)] as const))
    ]);
    const accessOf = new Map(accesses);
    const keptByMe = new Set(mine.map((row) => row.messageId));
    const channelOf = new Map(channels.map((row) => [row.id, row]));
    for (const row of candidates) {
        const kept = (row.keptExpiresAt ?? null) !== null;
        const channel = channelOf.get(row.channelId);
        const access = accessOf.get(row.channelId) ?? undefined;
        const mayKeep =
            policy.keep === "allowed" &&
            row.keepable !== false &&
            row.deletedAt === null &&
            !isEphemeral(row.audience) &&
            channel !== undefined &&
            access !== undefined &&
            access.member &&
            !keptByMe.has(row.id) &&
            mayKeepIn(actorId, access, channel);
        out.set(row.id, { kept, keptByMe: keptByMe.has(row.id), mayKeep });
    }
    return out;
}
