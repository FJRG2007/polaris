"use server";

/**
 * Inbox server actions. Every action is scoped to the signed-in user, who owns
 * their own channels and conversations; input is validated with Zod. Sending and
 * connecting reach the bridge through the server-only messaging service.
 */

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { PLATFORMS, interactivePromptSchema } from "@polaris/messaging";
import { requireUser } from "@/lib/session";
import { bridgeConfigured } from "@/lib/messaging/bridge-client";
import {
    connectChannel,
    deleteChannel,
    getConversationMessages,
    listChannels,
    listConversations,
    sendConversationMessage,
    type ChannelView,
    type ConversationView,
    type MessageView
} from "@/lib/messaging-service";

const connectChannelSchema = z.object({
    platform: z.enum(PLATFORMS),
    provider: z.string().trim().min(1).max(64).optional(),
    name: z.string().trim().min(1).max(64),
    token: z.string().trim().min(1).max(8192)
});

const sendSchema = z.object({
    conversationId: z.string().uuid(),
    text: z.string().trim().max(8192).optional(),
    interactive: interactivePromptSchema.optional()
});

export async function inboxStateAction(): Promise<{
    bridgeConfigured: boolean;
    channels: ChannelView[];
    conversations: ConversationView[];
}> {
    const user = await requireUser();
    const [channels, conversations] = await Promise.all([listChannels(user.id), listConversations(user.id)]);
    return { bridgeConfigured: bridgeConfigured(), channels, conversations };
}

export async function connectChannelAction(input: z.infer<typeof connectChannelSchema>): Promise<{ error?: string }> {
    const user = await requireUser();
    const parsed = connectChannelSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the form" };
    try {
        await connectChannel(user.id, parsed.data);
        revalidatePath("/inbox");
        return {};
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not connect the channel" };
    }
}

export async function deleteChannelAction(channelId: string): Promise<{ error?: string }> {
    const user = await requireUser();
    try {
        await deleteChannel(user.id, channelId);
        revalidatePath("/inbox");
        return {};
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not remove the channel" };
    }
}

export async function listConversationsAction(): Promise<ConversationView[]> {
    const user = await requireUser();
    return listConversations(user.id);
}

export async function getMessagesAction(conversationId: string): Promise<MessageView[]> {
    const user = await requireUser();
    return getConversationMessages(user.id, conversationId);
}

export async function sendMessageAction(input: z.infer<typeof sendSchema>): Promise<{ error?: string }> {
    const user = await requireUser();
    const parsed = sendSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Nothing to send" };
    if (!parsed.data.text && !parsed.data.interactive) return { error: "Type a message first" };
    try {
        await sendConversationMessage(user.id, parsed.data.conversationId, user.id, {
            text: parsed.data.text,
            interactive: parsed.data.interactive
        });
        return {};
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not send the message" };
    }
}
