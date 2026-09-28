/**
 * The instance's spam limits, applied to a message about to be sent.
 *
 * Set by whoever runs Polaris, per kind of conversation, in the chat rules
 * (`@polaris/core` chat-rules) - not by a space or a group, which is the point:
 * the room being spammed is not the one that gets to decide it is fine.
 *
 * Loose on purpose. Every limit counts one person in one conversation, and the
 * defaults sit well above anything somebody talking normally does; what they
 * catch is the clear abuse - the whole room pinged every few minutes, one person
 * mentioned over and over, the same line pasted again and again.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { ChatRuleError } from "./access";
import { channelMentions, extractReferences } from "@/components/rich-text/markdown";

/** How many people's mentions are checked against the recent ones, at most.
 *  The per-message limit already bounds a message; this bounds the check. */
const CHECKED_PEOPLE = 10;

/** How many of the author's recent messages are read for mentions of the same
 *  person. Far above what anyone sends in the window at the default rate. */
const RECENT_BODIES = 500;

/**
 * Refuse a message the spam limits do not allow.
 *
 * `editing` is an edit of a message already sent: only the per-message limit
 * applies to it, since the others count sending, and the message being edited
 * is already one of the ones counted.
 */
export async function requireNotSpam(input: {
    rules: core.ChatRules;
    channelId: string;
    authorId: string;
    body: string;
    /** Whether this author moderates the room, and so may call it together. */
    moderator: boolean;
    editing?: boolean;
    now?: number;
}): Promise<void> {
    const { rules, channelId, authorId, body } = input;
    if (!rules.spamGuard) return;
    const now = input.now ?? Date.now();

    const people = extractReferences(body).filter((ref) => ref.kind === "user" || ref.kind === "team");
    if (rules.maxMentionsPerMessage !== core.CHAT_NO_LIMIT && people.length > rules.maxMentionsPerMessage) {
        throw new ChatRuleError(
            `One message can mention up to ${rules.maxMentionsPerMessage} people here. Split it up, or use @everyone.`
        );
    }
    if (input.editing) return;

    const mine = { channelId, authorId };

    if (rules.maxRepeatedMessages !== core.CHAT_NO_LIMIT && body.trim().length > 0) {
        const same = await prisma.chatMessage.count({
            where: {
                ...mine,
                body,
                createdAt: { gte: new Date(now - core.CHAT_SPAM_WINDOWS.repeatedMs) }
            }
        });
        if (same >= rules.maxRepeatedMessages) {
            throw new ChatRuleError("You have just sent that same message several times. Give it a moment.");
        }
    }

    if (!input.moderator && channelMentions(body).size > 0) {
        await requireRoomMentionAllowed({ rules, channelId, authorId, now });
    }

    const mentioned = people.filter((ref) => ref.kind === "user").slice(0, CHECKED_PEOPLE);
    if (rules.maxSamePersonMentions !== core.CHAT_NO_LIMIT && mentioned.length > 0) {
        const recent = await prisma.chatMessage.findMany({
            where: { ...mine, createdAt: { gte: new Date(now - core.CHAT_SPAM_WINDOWS.samePersonMs) } },
            orderBy: { createdAt: "desc" },
            select: { body: true },
            take: RECENT_BODIES
        });
        const times = new Map<string, number>();
        for (const message of recent) {
            if (!message.body.toLowerCase().includes("polaris:user/")) continue;
            for (const ref of extractReferences(message.body)) {
                if (ref.kind === "user") times.set(ref.id, (times.get(ref.id) ?? 0) + 1);
            }
        }
        if (mentioned.some((person) => (times.get(person.id) ?? 0) >= rules.maxSamePersonMentions)) {
            throw new ChatRuleError(
                "You have mentioned the same person a lot in the last few minutes. They have been told - give them a moment."
            );
        }
    }
}

/**
 * Whether one more message calling the whole room together is allowed.
 *
 * Its own export because an edit asks it too: rewriting a message to add
 * @everyone announces it just as sending one does, and would otherwise be the
 * way around the limit.
 */
export async function requireRoomMentionAllowed(input: {
    rules: core.ChatRules;
    channelId: string;
    authorId: string;
    now?: number;
}): Promise<void> {
    const { rules } = input;
    if (!rules.spamGuard || rules.maxRoomMentionsPerHour === core.CHAT_NO_LIMIT) return;
    const now = input.now ?? Date.now();
    // Narrowed by the words first, then read properly: "@everyone" inside a code
    // block, or as part of an address, is not a mention of the room.
    const candidates = await prisma.chatMessage.findMany({
        where: {
            channelId: input.channelId,
            authorId: input.authorId,
            createdAt: { gte: new Date(now - core.CHAT_SPAM_WINDOWS.roomMentionsMs) },
            OR: [{ body: { contains: "@everyone" } }, { body: { contains: "@here" } }, { body: { contains: "@all" } }]
        },
        select: { body: true },
        take: rules.maxRoomMentionsPerHour + 20
    });
    const used = candidates.filter((message) => channelMentions(message.body).size > 0).length;
    if (used >= rules.maxRoomMentionsPerHour) {
        throw new ChatRuleError(
            `@everyone and @here can be used ${rules.maxRoomMentionsPerHour} ${rules.maxRoomMentionsPerHour === 1 ? "time" : "times"} an hour per person here. Send it without, or try again later.`
        );
    }
}
