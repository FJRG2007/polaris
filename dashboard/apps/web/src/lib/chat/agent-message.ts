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

import { prisma } from "@polaris/db";
import { publishChatChange } from "./live";
import { unhideOnMessage } from "./chat-lock";
import { expiryForChannel } from "./vanish";
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
}

/** Post it, and wake the conversation. Returns its id. */
export async function postAgentMessage(input: AgentMessage): Promise<string> {
    const stored = storedComponents(input.components ?? []);
    const expiresAt = await expiryForChannel(input.channelId, new Date());
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
                replyToId: input.replyToId,
                parentId: input.parentId,
                ...(expiresAt ? { expiresAt } : {})
            },
            select: { id: true, createdAt: true }
        });
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
    publishChatChange({ channelId: input.channelId, kind: "posted", actorId: "" });
    return id;
}
