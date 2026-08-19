/**
 * Finding something somebody said.
 *
 * The outer bound is never the filter - it is the set of conversations this
 * reader can currently reach, resolved here on every search rather than trusted
 * from the request. Somebody removed from a private channel yesterday must not
 * be able to search it today, and a `channelId` arriving from a browser is a
 * request, not a permission.
 *
 * Ranking is by time rather than relevance. A chat search is nearly always
 * somebody looking for a specific thing they remember happening, and "the most
 * recent time this was said" is the answer far more often than "the message with
 * the most matching words". It is also the only ordering that stays stable while
 * the conversation carries on underneath it.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { reachableChannelIds } from "./access";
import { decorateMessages, type ChatMessageView } from "./messages";

/** One result, with enough about where it was said to be worth clicking. */
export interface ChatSearchHit {
    readonly message: ChatMessageView;
    readonly channelId: string;
    readonly channelName: string;
    /** Whether it is a channel in a space rather than a private conversation,
     *  which is what the icon beside it says. */
    readonly inSpace: boolean;
}

export async function searchMessages(
    actor: { id: string },
    input: core.ChatSearchInput
): Promise<readonly ChatSearchHit[]> {
    if (core.chatSearchIsEmpty(input) && !input.channelId) return [];

    const reachable = await reachableChannelIds(actor);
    // A conversation named in the request is honoured only if it was already in
    // the set. Narrowing to something outside it narrows to nothing.
    const within = input.channelId
        ? reachable.has(input.channelId)
            ? [input.channelId]
            : []
        : [...reachable];
    if (within.length === 0) return [];

    const rows = await prisma.chatMessage.findMany({
        where: {
            channelId: { in: within },
            deletedAt: null,
            // System lines - "somebody joined", "a call started" - are noise in a
            // search for something a person said.
            kind: "text",
            ...(input.term ? { body: { contains: input.term, mode: "insensitive" as const } } : {}),
            ...(input.authorId ? { authorId: input.authorId } : {}),
            ...attachmentClause(input.has),
            ...dayClause(input.after, input.before)
        },
        orderBy: { createdAt: "desc" },
        take: core.CHAT_SEARCH_LIMIT,
        select: SEARCH_SELECT
    });
    if (rows.length === 0) return [];

    const channels = await prisma.chatChannel.findMany({
        where: { id: { in: [...new Set(rows.map((row) => row.channelId))] } },
        select: { id: true, name: true, spaceId: true }
    });
    const named = new Map(channels.map((channel) => [channel.id, channel]));

    // Left out rather than folded away. In the conversation a blocked message is
    // kept as a line so the replies under it still make sense; a result list has
    // no such shape to preserve, and a row saying "blocked message" is a row that
    // answers nothing somebody searched for.
    const decorated = (await decorateMessages(actor, rows)).filter((message) => !message.blocked);
    return decorated.map((message) => {
        const channel = named.get(message.channelId);
        return {
            message,
            channelId: message.channelId,
            // A direct message has no name of its own - the name is who is in it,
            // which the rail already resolved. Here it would cost a roster lookup
            // per hit, so the honest fallback is what it is.
            channelName: channel?.name || "Direct message",
            inSpace: Boolean(channel?.spaceId)
        };
    });
}

/** What the message has to be carrying. */
function attachmentClause(has: core.ChatSearchAttachment) {
    if (has === "file") return { attachments: { some: {} } };
    if (has === "image") {
        return { attachments: { some: { contentType: { startsWith: "image/" } } } };
    }
    if (has === "link") {
        // Matching the scheme rather than a word: "http" catches both, and a
        // message that merely says the word "link" is not one.
        return { body: { contains: "http", mode: "insensitive" as const } };
    }
    return {};
}

/**
 * Whole days rather than instants.
 *
 * Both ends are inclusive, because "before the 5th" meaning "not the 5th" is
 * nobody's reading of it. The day is taken in the server's own reckoning, which
 * is the one the timestamps were written in.
 */
function dayClause(after: string | null, before: string | null) {
    if (!after && !before) return {};
    const range: { gte?: Date; lte?: Date } = {};
    if (after) range.gte = new Date(`${after}T00:00:00`);
    if (before) range.lte = new Date(`${before}T23:59:59.999`);
    return { createdAt: range };
}

const SEARCH_SELECT = {
    id: true,
    channelId: true,
    authorId: true,
    kind: true,
    body: true,
    parentId: true,
    replyToId: true,
    forwarded: true,
    replyCount: true,
    lastReplyAt: true,
    editedAt: true,
    deletedAt: true,
    createdAt: true
} as const;
