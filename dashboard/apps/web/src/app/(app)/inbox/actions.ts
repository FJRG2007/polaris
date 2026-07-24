"use server";

/**
 * Inbox server actions. Every action is scoped to the signed-in user, who owns
 * their own channels and conversations; input is validated with Zod. Sending and
 * connecting reach the bridge through the server-only messaging service.
 */

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { PLATFORMS, interactivePromptSchema } from "@polaris/messaging";
import type { TargetGroup } from "@polaris/messaging";
import { requireUser } from "@/lib/session";
import { bridgeConfigured } from "@/lib/messaging/bridge-client";
import {
    addContactIdentity,
    assignConversation,
    channelState,
    connectChannel,
    createContact,
    deleteChannel,
    deleteContact,
    deleteContactIdentity,
    deleteConversation,
    getConversationMessages,
    listAgents,
    listChannelTargets,
    listChannels,
    listContacts,
    listConversations,
    listMessagingActivity,
    reconnectChannel,
    sendConversationMessage,
    startConversation,
    updateChannelCredentials,
    updateContact,
    updateContactIdentity,
    type ActivityView,
    type AgentView,
    type ChannelLiveState,
    type ChannelView,
    type ContactView,
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
        return {
            error: caught instanceof Error ? caught.message : "Could not connect the channel"
        };
    }
}

/** Poll a channel's live state (for the whatsapp-web QR onboarding). */
export async function channelStateAction(
    channelId: string
): Promise<ChannelLiveState & { error?: string }> {
    const user = await requireUser();
    try {
        return await channelState(user.id, channelId);
    } catch (caught) {
        return {
            status: "error",
            error: caught instanceof Error ? caught.message : "Could not read channel state"
        };
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

const updateChannelSchema = z.object({
    channelId: z.string().uuid(),
    name: z.string().trim().min(1).max(64).optional(),
    // A new credential (bot token / access token) to replace the stored one.
    token: z.string().trim().min(1).max(8192).optional(),
    // Provider-specific config (e.g. WhatsApp Cloud phoneNumberId).
    config: z.record(z.string(), z.string().max(256)).optional()
});

/** Edit a channel's name, credential, and/or provider config, reconnecting when
 *  the credential or config changed so the live adapter picks it up. */
export async function updateChannelAction(
    input: z.infer<typeof updateChannelSchema>
): Promise<{ error?: string; status?: string }> {
    const user = await requireUser();
    const parsed = updateChannelSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the form" };
    const { channelId, ...patch } = parsed.data;
    if (!patch.name && !patch.token && !patch.config) return { error: "Nothing to update" };
    try {
        const { status } = await updateChannelCredentials(user.id, channelId, patch);
        revalidatePath("/inbox");
        return { status };
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not update the channel" };
    }
}

/** Re-establish a channel's adapter, reusing its stored credentials. */
export async function reconnectChannelAction(
    channelId: string
): Promise<{ error?: string; status?: string }> {
    const user = await requireUser();
    try {
        const { status } = await reconnectChannel(user.id, channelId);
        revalidatePath("/inbox");
        return { status };
    } catch (caught) {
        return {
            error: caught instanceof Error ? caught.message : "Could not reconnect the channel"
        };
    }
}

export async function listConversationsAction(): Promise<ConversationView[]> {
    const user = await requireUser();
    return listConversations(user.id);
}

/** Send targets (servers -> channels) for a channel whose adapter enumerates them
 *  (Discord), for the recipient picker. Empty for other platforms or an old bridge. */
export async function listChannelTargetsAction(channelId: string): Promise<TargetGroup[]> {
    const user = await requireUser();
    if (!z.string().uuid().safeParse(channelId).success) return [];
    try {
        return await listChannelTargets(user.id, channelId);
    } catch {
        return [];
    }
}

/** The owner's first connected Discord channel (bot), used to populate the server/
 *  channel picker when a specific bot channel is not already in context (Contacts).
 *  Null when no Discord bot is connected. */
export async function firstDiscordChannelAction(): Promise<string | null> {
    const user = await requireUser();
    const channels = await listChannels(user.id);
    return channels.find((c) => c.platform === "discord" && c.status === "connected")?.id ?? null;
}

/** Recent messaging activity across the owner's channels, for the Logs view. */
export async function listActivityAction(): Promise<ActivityView[]> {
    const user = await requireUser();
    return listMessagingActivity(user.id);
}

export async function getMessagesAction(conversationId: string): Promise<MessageView[]> {
    const user = await requireUser();
    return getConversationMessages(user.id, conversationId);
}

/** Delete a conversation and its messages. */
export async function deleteConversationAction(conversationId: string): Promise<{ error?: string }> {
    const user = await requireUser();
    if (!z.string().uuid().safeParse(conversationId).success) return { error: "Invalid request" };
    try {
        await deleteConversation(user.id, conversationId);
        revalidatePath("/inbox");
        return {};
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not delete the conversation" };
    }
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
export async function assignConversationAction(
    input: z.infer<typeof assignSchema>
): Promise<{ error?: string }> {
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
        return {
            error: caught instanceof Error ? caught.message : "Could not update the conversation"
        };
    }
}

export async function sendMessageAction(
    input: z.infer<typeof sendSchema>
): Promise<{ error?: string }> {
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

const startConversationSchema = z.object({
    channelId: z.string().uuid(),
    peerId: z.string().trim().min(1).max(256),
    peerName: z.string().trim().max(120).optional(),
    text: z.string().trim().min(1).max(8192)
});

/** Start a new outbound conversation and send its first message. */
export async function startConversationAction(
    input: z.infer<typeof startConversationSchema>
): Promise<{ error?: string; conversationId?: string }> {
    const user = await requireUser();
    const parsed = startConversationSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the form" };
    try {
        const { conversationId } = await startConversation(user.id, user.id, parsed.data);
        revalidatePath("/inbox");
        return { conversationId };
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not start the chat" };
    }
}

export async function listContactsAction(): Promise<ContactView[]> {
    const user = await requireUser();
    return listContacts(user.id);
}

const createContactSchema = z.object({
    name: z.string().trim().min(1).max(120),
    note: z.string().trim().max(500).optional(),
    // Optional first handle; more can be added from the contact's detail.
    platform: z.enum(PLATFORMS).optional(),
    peerId: z.string().trim().min(1).max(256).optional()
});

/** Create a contact (person), optionally with a first messaging handle. */
export async function createContactAction(
    input: z.infer<typeof createContactSchema>
): Promise<{ error?: string; contact?: ContactView }> {
    const user = await requireUser();
    const parsed = createContactSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the form" };
    try {
        return { contact: await createContact(user.id, parsed.data) };
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not save the contact" };
    }
}

const updateContactSchema = z.object({
    id: z.string().uuid(),
    name: z.string().trim().min(1).max(120).optional(),
    note: z.string().trim().max(500).nullable().optional()
});

/** Rename a contact or edit its note. */
export async function updateContactAction(
    input: z.infer<typeof updateContactSchema>
): Promise<{ error?: string; contact?: ContactView }> {
    const user = await requireUser();
    const parsed = updateContactSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the form" };
    try {
        const { id, ...patch } = parsed.data;
        return { contact: await updateContact(user.id, id, patch) };
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not update the contact" };
    }
}

const addIdentitySchema = z.object({
    contactId: z.string().uuid(),
    platform: z.enum(PLATFORMS),
    peerId: z.string().trim().min(1).max(256)
});

/** Add a messaging handle (platform + number/id) to a contact. */
export async function addContactIdentityAction(
    input: z.infer<typeof addIdentitySchema>
): Promise<{ error?: string; contact?: ContactView }> {
    const user = await requireUser();
    const parsed = addIdentitySchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the form" };
    try {
        const { contactId, ...identity } = parsed.data;
        return { contact: await addContactIdentity(user.id, contactId, identity) };
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not add the handle" };
    }
}

const updateIdentitySchema = z.object({
    identityId: z.string().uuid(),
    platform: z.enum(PLATFORMS).optional(),
    peerId: z.string().trim().min(1).max(256).optional()
});

/** Edit a handle's platform or number/id (e.g. correct a wrong number). */
export async function updateContactIdentityAction(
    input: z.infer<typeof updateIdentitySchema>
): Promise<{ error?: string; contact?: ContactView }> {
    const user = await requireUser();
    const parsed = updateIdentitySchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the form" };
    try {
        const { identityId, ...patch } = parsed.data;
        return { contact: await updateContactIdentity(user.id, identityId, patch) };
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not update the handle" };
    }
}

/** Remove one handle from a contact; returns the contact without it. */
export async function deleteContactIdentityAction(
    identityId: string
): Promise<{ error?: string; contact?: ContactView }> {
    const user = await requireUser();
    if (!z.string().uuid().safeParse(identityId).success) return { error: "Invalid request" };
    try {
        return { contact: await deleteContactIdentity(user.id, identityId) };
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not remove the handle" };
    }
}

export async function deleteContactAction(id: string): Promise<{ error?: string }> {
    const user = await requireUser();
    try {
        await deleteContact(user.id, id);
        return {};
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not remove the contact" };
    }
}
