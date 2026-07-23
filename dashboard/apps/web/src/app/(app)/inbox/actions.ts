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
    assignConversation,
    channelState,
    connectChannel,
    deleteChannel,
    getConversationMessages,
    listAgents,
    listChannels,
    listConversations,
    sendConversationMessage,
    type AgentView,
    type ChannelLiveState,
    type ChannelView,
    type ConversationView,
    type MessageView
} from "@/lib/messaging-service";

const connectChannelSchema = z.object({
    platform: z.enum(PLATFORMS),
    provider: z.string().trim().min(1).max(64).optional(),
    name: z.string().trim().min(1).max(64),
    // Absent for whatsapp-web (QR login); required for token-based providers.
    token: z.string().trim().min(1).max(8192).optional(),
    config: z.record(z.string(), z.string().max(256)).optional()
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
    const [ready, channels, conversations] = await Promise.all([
        bridgeConfigured(),
        listChannels(user.id),
        listConversations(user.id)
    ]);
    return { bridgeConfigured: ready, channels, conversations };
}

export async function connectChannelAction(
    input: z.infer<typeof connectChannelSchema>
): Promise<{ error?: string; channelId?: string; status?: string }> {
    const user = await requireUser();
    const parsed = connectChannelSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the form" };
    try {
        const channel = await connectChannel(user.id, parsed.data);
        revalidatePath("/inbox");
        return { channelId: channel.id, status: channel.status };
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not connect the channel" };
    }
}

/** Poll a channel's live state (for the whatsapp-web QR onboarding). */
export async function channelStateAction(channelId: string): Promise<ChannelLiveState & { error?: string }> {
    const user = await requireUser();
    try {
        return await channelState(user.id, channelId);
    } catch (caught) {
        return { status: "error", error: caught instanceof Error ? caught.message : "Could not read channel state" };
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

/** Workspace users a conversation can be assigned to (support agents). */
export async function listAgentsAction(): Promise<AgentView[]> {
    await requireUser();
    return listAgents();
}

const assignSchema = z.object({
    conversationId: z.string().uuid(),
    assigneeId: z.string().uuid().nullable().optional(),
    status: z.enum(["open", "closed", "pending"]).optional()
});

/** Assign a conversation to an agent and/or set its status (multi-agent support). */
export async function assignConversationAction(input: z.infer<typeof assignSchema>): Promise<{ error?: string }> {
    const user = await requireUser();
    const parsed = assignSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid request" };
    try {
        await assignConversation(user.id, parsed.data.conversationId, {
            assigneeId: parsed.data.assigneeId,
            status: parsed.data.status
        });
        return {};
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not update the conversation" };
    }
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
