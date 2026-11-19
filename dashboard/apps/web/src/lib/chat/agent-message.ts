/**
 * A message Polaris itself writes into a conversation as one of its own
 * assistants or apps - Polar answering, Tasks confirming what a command made.
 *
 * No account behind it (`authorId` null): `agent` names what wrote it and
 * `authorLabel` is its name, so the screen draws it as that app and never as a
 * person. It quotes the message that asked, lands in the same thread, and
 * disappears with the conversation's timer like everything else there.
 *
 * Server-only.
 */

import { publishChatChange } from "./live";
import { unhideOnMessage } from "./chat-lock";
import { expiryForChannel } from "./vanish";
import { prisma, Prisma } from "@polaris/db";
import { ephemeralExpiry, isEphemeral, MOST_AUDIENCE } from "./ephemeral";
import { storedComponents, type MessageComponentInput } from "./message-components";

export interface AgentMessage {
    readonly channelId: string;
    readonly parentId: string | null;
    /** The message that asked, quoted above the answer. */
    readonly replyToId: string | null;
    readonly agent: string;
    readonly label: string;
    readonly body: string;
    readonly components?: readonly MessageComponentInput[];
    /**
     * Ephemeral: only these people see it ("Only you can see this"), as
     * Discord's flag 64. Absent or empty is the whole conversation. An
     * ephemeral answer does not move the conversation up the rail, count as
     * unread or reach anybody's notifications - see `ephemeral`.
     */
    readonly audience?: readonly string[];
}

/** Post it, and wake the conversation - or only its audience. Returns its id. */
export async function postAgentMessage(input: AgentMessage): Promise<string> {
    const stored = storedComponents(input.components ?? []);
    const audience = [...new Set(input.audience ?? [])].slice(0, MOST_AUDIENCE);
    const ephemeral = audience.length > 0;
    const now = new Date();
    const channelExpiry = await expiryForChannel(input.channelId, now);
    const expiresAt = ephemeral ? ephemeralExpiry(now, channelExpiry) : channelExpiry;
    const id = await prisma.$transaction(async (tx) => {
        const message = await tx.chatMessage.create({
            data: {
                channelId: input.channelId,
                authorId: null,
                kind: "text",
                body: input.body,
                agent: input.agent,
                authorLabel: input.label,
                ...(stored.length ? { components: stored } : {}),
                ...(ephemeral ? { audience } : {}),
                replyToId: input.replyToId,
                parentId: input.parentId,
                ...(expiresAt ? { expiresAt } : {})
            },
            select: { id: true, createdAt: true }
        });
        // Nothing the rest of the room can see happened, so nothing of the
        // room's moves: not its place on the rail, not a thread's count.
        if (ephemeral) return message.id;
        await tx.chatChannel.update({
            where: { id: input.channelId },
            data: { lastMessageAt: message.createdAt }
        });
        if (input.parentId) {
            await tx.chatMessage.update({
                where: { id: input.parentId },
                data: { replyCount: { increment: 1 }, lastReplyAt: message.createdAt }
            });
        }
        await unhideOnMessage(tx, input.channelId, null, message.createdAt);
        return message.id;
    });
    publishChatChange({
        channelId: input.channelId,
        kind: "posted",
        actorId: "",
        // No ids: a frame naming ids is "these changed", and the audience's
        // screens have to read this one as new.
        ...(ephemeral ? { audience } : {})
    });
    return id;
}

export interface AgentMessageUpdate {
    readonly messageId: string;
    readonly channelId: string;
    /** Whoever wrote it: nothing else may change it. */
    readonly agent: string;
    readonly body?: string;
    /** The new set, which replaces the old one; an empty list takes them all off. */
    readonly components?: readonly MessageComponentInput[];
}

/**
 * Change a message Polar or an app wrote - Discord's UPDATE_MESSAGE. Only the
 * one that wrote it (`agent`) changes it, it is marked edited exactly as a
 * person's edit is (the earlier words kept when the conversation keeps edit
 * history), and every screen that can see it redraws it.
 *
 * Returns whether there was such a message to change.
 */
export async function updateAgentMessage(input: AgentMessageUpdate): Promise<boolean> {
    if (input.body === undefined && input.components === undefined) return false;
    const stored = input.components === undefined ? undefined : storedComponents(input.components);
    const current = await prisma.chatMessage.findFirst({
        where: { id: input.messageId, channelId: input.channelId, agent: input.agent, authorId: null, deletedAt: null },
        select: { body: true, audience: true }
    });
    if (!current) return false;
    const editedAt = new Date();
    const keepHistory = input.body !== undefined && input.body !== current.body
        ? (await import("./rules").then((rules) => rules.rulesForChannel(input.channelId))).keepEditHistory
        : false;
    const changed = await prisma.$transaction(async (tx) => {
        const updated = await tx.chatMessage.updateMany({
            where: { id: input.messageId, channelId: input.channelId, agent: input.agent, deletedAt: null },
            data: {
                editedAt,
                ...(input.body !== undefined ? { body: input.body } : {}),
                ...(stored !== undefined ? { components: stored.length ? stored : Prisma.DbNull } : {})
            }
        });
        if (updated.count > 0 && keepHistory) {
            await tx.chatMessageEdit.create({
                data: { messageId: input.messageId, body: current.body, replacedAt: editedAt }
            });
        }
        return updated.count > 0;
    });
    if (!changed) return false;
    publishChatChange({
        channelId: input.channelId,
        kind: "posted",
        actorId: "",
        messageIds: [input.messageId],
        ...(isEphemeral(current.audience) ? { audience: current.audience } : {})
    });
    return true;
}
