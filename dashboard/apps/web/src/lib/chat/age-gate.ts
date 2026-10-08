/**
 * An age-restricted channel, Discord's way.
 *
 * Whoever runs a channel can mark it age-restricted (`contentMode: "age"`).
 * Nobody reads it until they have said they are an adult: the conversation
 * shows a gate instead of its messages, and saying yes is remembered per person
 * and per channel (`ChatAgeConfirmation`), so it is asked once.
 *
 * Enforced where messages are read, not only drawn: a page, the catch-up after
 * a frame, a thread, a single message carried somewhere, pins, search, stars,
 * toasts, a quoted message link, edit history and forwarding all refuse a
 * channel this reader has not confirmed. The screen asking first is the
 * courtesy; this is the rule.
 *
 * It is a statement, not a verification - Polaris has no way to know anybody's
 * age, and neither does Discord. What it buys is that nobody walks into such a
 * channel by accident.
 */

import { prisma } from "@polaris/db";
import { ChatAccessError, requireChannel, type ChatActor } from "./access";

/** Whether this reader still has to confirm before reading this channel. */
export async function ageGateClosed(actorId: string, channelId: string): Promise<boolean> {
    const channel = await prisma.chatChannel.findUnique({
        where: { id: channelId },
        select: {
            spaceId: true,
            contentMode: true,
            ageConfirmations: { where: { userId: actorId }, select: { id: true }, take: 1 }
        }
    });
    if (!channel || !channel.spaceId || channel.contentMode !== "age") return false;
    return (channel.ageConfirmations ?? []).length === 0;
}

/** The same, refused - for every read of the channel's messages. */
export async function requireAgeCleared(actor: ChatActor, channelId: string): Promise<void> {
    if (await ageGateClosed(actor.id, channelId)) {
        throw new ChatAccessError({ key: "errors.ageRestricted" });
    }
}

/**
 * Say yes at the gate.
 *
 * Only somebody who can reach the channel, so a confirmation is never written
 * for a room the reader cannot see. Idempotent: confirming twice is one row.
 */
export async function confirmAge(actor: ChatActor, channelId: string): Promise<void> {
    await requireChannel(actor, channelId);
    await prisma.chatAgeConfirmation.upsert({
        where: { channelId_userId: { channelId, userId: actor.id } },
        update: {},
        create: { channelId, userId: actor.id }
    });
}

/**
 * A `where` on messages that leaves out every age-restricted channel this reader
 * has not confirmed - for the reads that span many channels at once, like
 * search, where asking one channel at a time would be a query per hit.
 */
export function ageClearedWhere(actorId: string) {
    return {
        channel: {
            OR: [
                { contentMode: { not: "age" } },
                { spaceId: null },
                { ageConfirmations: { some: { userId: actorId } } }
            ]
        }
    };
}
