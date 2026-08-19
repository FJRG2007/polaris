/**
 * What a message looks like when it is announced rather than read.
 *
 * Chat needed a way to tell somebody a message arrived while they were in Tasks
 * or in Drive, and the notifications table was the wrong place for it: that is a
 * record - a list somebody goes back to and clears - and a chat message is not.
 * Fifty of them in an afternoon would bury the four notifications that mattered.
 * So this writes nothing at all. It is read off the live frame, shown for a few
 * seconds, and gone.
 *
 * Three things are decided here rather than in the browser, because all three
 * are about access or about somebody's settings:
 *
 * - only conversations this reader is actually in;
 * - never a muted one, muted being worked out rather than read, since a mute
 *   with an end that has passed is not a mute;
 * - never somebody they have blocked, which is the same rule as the mute and a
 *   stronger one: a mute silences a room, and this silences a person in every
 *   room at once;
 * - the text is the excerpt, not the Markdown, and never the reader's own
 *   message.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { blockedBy } from "@/lib/blocks";
import { plainExcerpt } from "@/components/rich-text/excerpt";
import { reachableChannelIds, type ChatActor } from "./access";

/** How much of a message the toast carries. A line, like every other
 *  notification anywhere. */
const EXCERPT = 90;

/** How many conversations one announcement covers. A burst bigger than this is
 *  somebody catching up, and a stack of toasts is not how they should find out. */
const MOST_CHANNELS = 6;

/** How old a message can be and still be worth announcing. The frame that
 *  triggered this is seconds old; anything older came back with it and has been
 *  waiting, which is the unread badge's job rather than a toast's. */
const RECENT_MS = 60_000;

/** One arrival, as the toast draws it. */
export interface MessageToast {
    readonly channelId: string;
    readonly messageId: string;
    /** What the conversation is called, from this reader's side: a channel's
     *  name, or whoever is in the direct message. */
    readonly conversation: string;
    /** Whether it is a channel rather than a direct message, which decides
     *  whether the line reads "Ana" or "Ana in #general". */
    readonly inChannel: boolean;
    readonly authorId: string | null;
    readonly authorName: string;
    readonly excerpt: string;
    readonly at: string;
}

/**
 * The newest message in each of these conversations, for whoever is being told.
 *
 * The channel ids arrive from a browser, so they are intersected with what this
 * reader can reach rather than trusted - the whole answer is somebody else's
 * conversation otherwise.
 */
export async function messageToasts(
    actor: ChatActor,
    channelIds: readonly string[]
): Promise<MessageToast[]> {
    const reachable = await reachableChannelIds(actor);
    const asked = [...new Set(channelIds)].filter((id) => reachable.has(id)).slice(0, MOST_CHANNELS);
    if (asked.length === 0) return [];

    const memberships = await prisma.chatChannelMember.findMany({
        where: { userId: actor.id, channelId: { in: asked } },
        select: { channelId: true, muted: true, mutedUntil: true }
    });
    const quiet = new Set(
        memberships.filter((row) => core.muteInForce(row)).map((row) => row.channelId)
    );

    const wanted = asked.filter((id) => !quiet.has(id));
    if (wanted.length === 0) return [];

    const since = new Date(Date.now() - RECENT_MS);
    const rows = await prisma.chatMessage.findMany({
        where: {
            channelId: { in: wanted },
            deletedAt: null,
            createdAt: { gte: since },
            // Never your own: the tab that sent it is already showing it, and
            // the other tabs of the same person do not need telling.
            authorId: { not: actor.id }
        },
        orderBy: { createdAt: "desc" },
        // One per conversation is the shape, and this is the cheap way to it:
        // a small window, then the first of each channel.
        take: MOST_CHANNELS * 4,
        select: {
            id: true,
            channelId: true,
            body: true,
            createdAt: true,
            authorId: true,
            channel: {
                select: {
                    name: true,
                    spaceId: true,
                    members: { select: { userId: true, user: { select: { name: true } } } }
                }
            }
        }
    });

    // The author is not a relation - a message outlives the account that wrote
    // it - so the names are a second, small lookup.
    const authorIds = [...new Set(rows.map((row) => row.authorId).filter((id) => id !== null))];
    const authors = authorIds.length
        ? await prisma.user.findMany({
              where: { id: { in: authorIds } },
              select: { id: true, name: true }
          })
        : [];
    const names = new Map(authors.map((author) => [author.id, author.name]));

    // Applied after the read rather than inside it, so one conversation whose
    // newest message is from a blocked account falls through to nothing rather
    // than announcing whatever they said before it.
    const blocked = await blockedBy(
        actor.id,
        rows.map((row) => row.authorId).filter((id): id is string => id !== null)
    );

    const seen = new Set<string>();
    const toasts: MessageToast[] = [];
    for (const row of rows) {
        if (seen.has(row.channelId)) continue;
        if (row.authorId && blocked.has(row.authorId)) {
            seen.add(row.channelId);
            continue;
        }
        seen.add(row.channelId);

        const others = row.channel.members
            .filter((member) => member.userId !== actor.id)
            .map((member) => member.user.name);
        toasts.push({
            channelId: row.channelId,
            messageId: row.id,
            conversation: row.channel.spaceId
                ? row.channel.name
                : row.channel.name || others.join(", ") || "Direct message",
            inChannel: row.channel.spaceId !== null,
            authorId: row.authorId,
            authorName: (row.authorId && names.get(row.authorId)) || "Somebody",
            excerpt: plainExcerpt(row.body, EXCERPT),
            at: row.createdAt.toISOString()
        });
    }
    return toasts;
}
