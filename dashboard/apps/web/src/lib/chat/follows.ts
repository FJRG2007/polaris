/**
 * Following an announcement channel, and publishing into its followers.
 *
 * Discord's model [D4 in docs/chat-roadmap.md]: an administrator of another
 * space follows an announcement channel into one of their own text channels,
 * and from then on whatever an administrator of the source publishes is copied
 * there, signed with where it came from.
 *
 * A copy is a message with no author, labelled "Space · #channel", carrying the
 * id of the message it was copied from. `ChatMessage(channelId,
 * publishedFromId)` is unique, so publishing the same message twice - or two
 * administrators pressing Publish at once - delivers it once per follower, and
 * pressing it again after a failure finishes the followers it missed.
 *
 * There is no general job queue in this app, so the fan-out runs in the request
 * and is bounded by `MAX_CHANNEL_FOLLOWERS` instead, a few at a time.
 */

import * as core from "@polaris/core";
import { isEphemeral } from "./ephemeral";
import { publishChatChange } from "./live";
import { prisma, Prisma } from "@polaris/db";
import { unhideOnMessage } from "./chat-lock";
import {
    ChatRuleError,
    requireSpace,
    spaceAccess,
    requireChannel,
    reachableSpaceIds,
    type ChatActor
} from "./access";

/** How many followers are written at once while publishing. */
const PUBLISH_BATCH = 10;

/** A channel the reader may follow an announcement channel into. */
export interface ChatFollowTarget {
    readonly channelId: string;
    readonly name: string;
    readonly spaceId: string;
    readonly spaceName: string;
    /** The follow already in place, or null when it is not followed there. */
    readonly followId: string | null;
}

export interface ChatPublishResult {
    /** Followers the message reached now. */
    readonly delivered: number;
    /** Followers that already had it. */
    readonly already: number;
}

async function isAdmin(actor: ChatActor, spaceId: string): Promise<boolean> {
    return requireSpace(actor, spaceId, "admin").then(
        () => true,
        () => false
    );
}

/** An announcement channel the reader can open, or a refusal. */
async function requireAnnouncement(actor: ChatActor, channelId: string) {
    const access = await requireChannel(actor, channelId);
    const channel = await prisma.chatChannel.findUnique({
        where: { id: channelId },
        select: {
            id: true,
            name: true,
            kind: true,
            spaceId: true,
            membersMaySend: true,
            space: { select: { name: true } }
        }
    });
    if (!channel || !core.isAnnouncementChannel(channel)) {
        throw new ChatRuleError({ key: "errors.follow.notAnnouncement" });
    }
    return { access, channel };
}

/** A text channel in a space the reader administers: where a follow may land. */
async function requireTarget(actor: ChatActor, channelId: string) {
    const access = await requireChannel(actor, channelId);
    if (!access.spaceId || access.kind !== "text" || access.archived) {
        throw new ChatRuleError({ key: "errors.follow.badTarget" });
    }
    await requireSpace(actor, access.spaceId, "admin");
    return access;
}

/** The channels the reader may follow this announcement channel into. */
export async function followTargets(
    actor: ChatActor,
    sourceChannelId: string
): Promise<ChatFollowTarget[]> {
    await requireAnnouncement(actor, sourceChannelId);
    const spaces = [...(await reachableSpaceIds(actor))];
    const access = await Promise.all(spaces.map((id) => spaceAccess(actor, id)));
    const administered = spaces.filter((_, index) => access[index] && access[index] !== "member");
    if (administered.length === 0) return [];
    const channels = await prisma.chatChannel.findMany({
        where: {
            spaceId: { in: administered },
            kind: "text",
            archived: false,
            id: { not: sourceChannelId }
        },
        orderBy: [{ spaceId: "asc" }, { order: "asc" }],
        take: core.MAX_CHANNEL_FOLLOWERS,
        select: {
            id: true,
            name: true,
            spaceId: true,
            space: { select: { name: true } },
            following: { where: { sourceChannelId }, select: { id: true }, take: 1 }
        }
    });
    return channels.map((channel) => ({
        channelId: channel.id,
        name: channel.name,
        spaceId: channel.spaceId ?? "",
        spaceName: channel.space?.name ?? "",
        followId: channel.following[0]?.id ?? null
    }));
}

/** Follow an announcement channel into one of the reader's channels. Following
 *  it twice into the same place is the one follow. */
export async function follow(actor: ChatActor, input: core.ChatChannelFollowInput): Promise<string> {
    if (input.sourceChannelId === input.targetChannelId) {
        throw new ChatRuleError({ key: "errors.follow.badTarget" });
    }
    await requireAnnouncement(actor, input.sourceChannelId);
    await requireTarget(actor, input.targetChannelId);
    const existing = await prisma.chatChannelFollow.findUnique({
        where: {
            sourceChannelId_targetChannelId: {
                sourceChannelId: input.sourceChannelId,
                targetChannelId: input.targetChannelId
            }
        },
        select: { id: true }
    });
    if (existing) return existing.id;
    const count = await prisma.chatChannelFollow.count({
        where: { sourceChannelId: input.sourceChannelId }
    });
    if (count >= core.MAX_CHANNEL_FOLLOWERS) throw new ChatRuleError({ key: "errors.follow.tooMany" });
    const row = await prisma.chatChannelFollow.upsert({
        where: {
            sourceChannelId_targetChannelId: {
                sourceChannelId: input.sourceChannelId,
                targetChannelId: input.targetChannelId
            }
        },
        create: {
            sourceChannelId: input.sourceChannelId,
            targetChannelId: input.targetChannelId,
            createdById: actor.id
        },
        update: {},
        select: { id: true }
    });
    return row.id;
}

/** Stop following. Whoever administers the channel it lands in may, and so may
 *  the source's administrators, who can drop a follower they do not want. */
export async function unfollow(actor: ChatActor, input: core.ChatChannelFollowInput): Promise<void> {
    const row = await prisma.chatChannelFollow.findUnique({
        where: {
            sourceChannelId_targetChannelId: {
                sourceChannelId: input.sourceChannelId,
                targetChannelId: input.targetChannelId
            }
        },
        select: {
            id: true,
            source: { select: { spaceId: true } },
            target: { select: { spaceId: true } }
        }
    });
    if (!row) return;
    const spaces = [row.target.spaceId, row.source.spaceId].filter((id): id is string => Boolean(id));
    const allowed = await Promise.all(spaces.map((id) => isAdmin(actor, id)));
    if (!allowed.some(Boolean)) throw new ChatRuleError({ key: "errors.spaceAdminOnly" });
    await prisma.chatChannelFollow.deleteMany({ where: { id: row.id } });
}

/** Whether a failed write was the unique index saying the copy is already there. */
function isDuplicate(error: unknown): boolean {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

/** The label a copy is signed with: where it was published from. */
export function originLabel(spaceName: string, channelName: string): string {
    const channel = `#${channelName}`;
    return (spaceName ? `${spaceName} · ${channel}` : channel).slice(0, 80);
}

/** Copy into one follower. False when it already had it. */
async function deliver(
    targetChannelId: string,
    source: { id: string; channelId: string; body: string },
    label: string
): Promise<boolean> {
    try {
        await prisma.$transaction(async (tx) => {
            const message = await tx.chatMessage.create({
                data: {
                    channelId: targetChannelId,
                    authorId: null,
                    kind: "text",
                    body: source.body,
                    authorLabel: label,
                    publishedFromId: source.id,
                    publishedFromChannelId: source.channelId
                },
                select: { createdAt: true }
            });
            await tx.chatChannel.update({
                where: { id: targetChannelId },
                data: { lastMessageAt: message.createdAt }
            });
            await unhideOnMessage(tx, targetChannelId, null, message.createdAt);
        });
    } catch (error) {
        if (isDuplicate(error)) return false;
        throw error;
    }
    publishChatChange({ channelId: targetChannelId, kind: "posted", actorId: "" });
    return true;
}

/**
 * Copy one of an announcement channel's messages into every follower.
 *
 * Only an administrator of the source's space may, only a message of the
 * channel itself (not a thread reply, a poll, a notice or one meant for a few),
 * and only its words: files are refused rather than dropped, so a copy never
 * reads as complete when it is not.
 */
export async function publish(actor: ChatActor, input: core.ChatPublishInput): Promise<ChatPublishResult> {
    const message = await prisma.chatMessage.findUnique({
        where: { id: input.messageId },
        select: {
            id: true,
            channelId: true,
            kind: true,
            body: true,
            parentId: true,
            deletedAt: true,
            audience: true,
            publishedFromId: true,
            attachments: { select: { id: true }, take: 1 }
        }
    });
    if (!message || message.deletedAt || isEphemeral(message.audience)) {
        throw new ChatRuleError({ key: "errors.messageGone" });
    }
    const { channel } = await requireAnnouncement(actor, message.channelId);
    await requireSpace(actor, channel.spaceId as string, "admin");
    if (message.parentId || message.kind !== "text" || message.publishedFromId || !message.body.trim()) {
        throw new ChatRuleError({ key: "errors.follow.notPublishable" });
    }
    if (message.attachments.length > 0) throw new ChatRuleError({ key: "errors.follow.filesNotPublished" });

    const followers = await prisma.chatChannelFollow.findMany({
        where: { sourceChannelId: channel.id, target: { archived: false } },
        orderBy: { createdAt: "asc" },
        take: core.MAX_CHANNEL_FOLLOWERS,
        select: { targetChannelId: true }
    });
    const label = originLabel(channel.space?.name ?? "", channel.name);
    let delivered = 0;
    for (let start = 0; start < followers.length; start += PUBLISH_BATCH) {
        const batch = followers.slice(start, start + PUBLISH_BATCH);
        const results = await Promise.all(
            batch.map((row) => deliver(row.targetChannelId, message, label))
        );
        delivered += results.filter(Boolean).length;
    }
    return { delivered, already: followers.length - delivered };
}
