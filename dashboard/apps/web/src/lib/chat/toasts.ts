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
 * - never one they set to nothing, and in one they set to mentions only the
 *   messages that name them or the room - the standing preference beside the
 *   mute, which is the whole of what a toast, a sound and a desktop notice
 *   obey;
 * - never somebody they have blocked, which is the same rule as the mute and a
 *   stronger one: a mute silences a room, and this silences a person in every
 *   room at once;
 * - the text is the excerpt, not the Markdown, and never the reader's own
 *   message.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { blockedBy } from "@/lib/blocks";
import { mentionsReader, notifyLevels, readerTeams } from "./notify";
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

/** How far down one conversation is read to find its newest message. More than
 *  one because the newest may be from somebody blocked, and then the answer is
 *  nothing rather than whatever they said before it. */
const NEWEST = 4;

/** How far down a conversation followed for mentions is read. Further, and it
 *  has to be: the message that names somebody is usually not the newest one, and
 *  a share of one window across every conversation would lose it behind a burst
 *  in a busier room - which is the room somebody sets this on. */
const SIFTED = 60;

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
    const asked = [...new Set(channelIds)]
        .filter((id) => reachable.has(id))
        .slice(0, MOST_CHANNELS);
    if (asked.length === 0) return [];

    const memberships = await prisma.chatChannelMember.findMany({
        where: { userId: actor.id, channelId: { in: asked } },
        select: { channelId: true, muted: true, mutedUntil: true }
    });
    const quiet = new Set(
        memberships.filter((row) => core.muteInForce(row)).map((row) => row.channelId)
    );

    // What each of them is allowed to interrupt with. A conversation set to
    // nothing is dropped here; one set to mentions keeps its place and has its
    // messages sifted below, because the newest message in it is usually not the
    // one that names anybody.
    const levels = await notifyLevels(actor.id, asked);
    const wanted = asked.filter((id) => !quiet.has(id) && levels.get(id) !== "none");
    if (wanted.length === 0) return [];

    const since = new Date(Date.now() - RECENT_MS);
    // A conversation followed for mentions is read on its own and read deeper.
    // Sharing one window across all of them looks the same until a busy room is
    // in it, and then that room's traffic pushes everybody else's mention out of
    // the window and the mention is never announced at all - Chat writes no
    // record for one, so it is lost rather than waiting in the bell.
    const sifted = wanted.filter((id) => levels.get(id) === "mentions");
    const plain = wanted.filter((id) => levels.get(id) !== "mentions");
    const [teams, windows] = await Promise.all([
        // Only where something is being sifted: everywhere else a `@team` is
        // just another message, which is already being announced.
        sifted.length ? readerTeams(actor.id) : Promise.resolve(new Set<string>()),
        Promise.all([
            ...(plain.length ? [recentIn(actor.id, plain, since, plain.length * NEWEST)] : []),
            ...sifted.map((id) => recentIn(actor.id, [id], since, SIFTED))
        ])
    ]);
    // Newest first within each window, which is all the loop below reads, and no
    // conversation is in two of them.
    const rows = windows.flat();

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
        // Not `seen` on the way past: the next message down in the same
        // conversation may be the one that named them, and a channel followed
        // for mentions is announced by the mention rather than by whatever was
        // said after it.
        if (
            levels.get(row.channelId) === "mentions" &&
            !mentionsReader(row.body, actor.id, teams)
        ) {
            continue;
        }
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

/**
 * The recent messages of these conversations, newest first, up to `take`.
 *
 * One shape for both windows so the two reads cannot drift apart in what they
 * select or in what they leave out. Never the reader's own: the tab that sent it
 * is already showing it, and the other tabs of the same person do not need
 * telling.
 */
function recentIn(userId: string, channelIds: readonly string[], since: Date, take: number) {
    return prisma.chatMessage.findMany({
        where: {
            channelId: { in: [...channelIds] },
            deletedAt: null,
            createdAt: { gte: since },
            authorId: { not: userId }
        },
        orderBy: { createdAt: "desc" },
        take,
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
}
