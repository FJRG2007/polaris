"use server";

/**
 * Channel server actions. Every action is scoped to the signed-in user, who owns
 * their own channels; input is validated with Zod. Connecting reaches the bridge
 * through the server-only messaging service.
 */

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { PLATFORMS } from "@polaris/messaging";
import { requirePermission } from "@/lib/session";
import { getTranslations } from "@/lib/i18n/request";
import type { NamespaceKey } from "@/lib/i18n/types";
import { bridgeConfigured } from "@/lib/messaging/bridge-client";
import {
    channelState,
    connectChannel,
    deleteChannel,
    listChannels,
    reconnectChannel,
    updateChannelCredentials,
    type ChannelLiveState,
    type ChannelView
} from "@/lib/messaging-service";

/** A reply in the language of whoever pressed the button. */
async function say(key: NamespaceKey<"admin">): Promise<string> {
    return (await getTranslations("admin"))(key);
}

const connectChannelSchema = z.object({
    platform: z.enum(PLATFORMS),
    provider: z.string().trim().min(1).max(64).optional(),
    name: z.string().trim().min(1).max(64),
    // Absent for whatsapp-web (QR login); required for token-based providers.
    token: z.string().trim().min(1).max(8192).optional(),
    config: z.record(z.string(), z.string().max(256)).optional()
});

/** The owner's channels and whether the bridge answers. */
export async function channelsStateAction(): Promise<{
    bridgeConfigured: boolean;
    channels: ChannelView[];
}> {
    const user = await requirePermission("inbox.read");
    const [ready, channels] = await Promise.all([bridgeConfigured(), listChannels(user.id)]);
    return { bridgeConfigured: ready, channels };
}

export async function connectChannelAction(
    input: z.infer<typeof connectChannelSchema>
): Promise<{ error?: string; channelId?: string; status?: string }> {
    const user = await requirePermission("inbox.manage");
    const parsed = connectChannelSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? await say("inbox.errors.checkForm") };
    try {
        const channel = await connectChannel(user.id, parsed.data);
        revalidatePath("/admin/email/channels");
        return { channelId: channel.id, status: channel.status };
    } catch (caught) {
        return {
            error: caught instanceof Error ? caught.message : await say("inbox.errors.connectFailed")
        };
    }
}

/** Poll a channel's live state (for the whatsapp-web QR onboarding and re-link). */
export async function channelStateAction(
    channelId: string
): Promise<ChannelLiveState & { error?: string }> {
    const user = await requirePermission("inbox.read");
    try {
        return await channelState(user.id, channelId);
    } catch (caught) {
        return {
            status: "error",
            error: caught instanceof Error ? caught.message : await say("inbox.errors.stateFailed")
        };
    }
}

export async function deleteChannelAction(channelId: string): Promise<{ error?: string }> {
    const user = await requirePermission("inbox.manage");
    try {
        await deleteChannel(user.id, channelId);
        revalidatePath("/admin/email/channels");
        return {};
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : await say("inbox.errors.removeChannelFailed") };
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
    const user = await requirePermission("inbox.manage");
    const parsed = updateChannelSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? await say("inbox.errors.checkForm") };
    const { channelId, ...patch } = parsed.data;
    if (!patch.name && !patch.token && !patch.config) return { error: await say("inbox.errors.nothingToUpdate") };
    try {
        const { status } = await updateChannelCredentials(user.id, channelId, patch);
        revalidatePath("/admin/email/channels");
        return { status };
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : await say("inbox.errors.updateChannelFailed") };
    }
}

/** Re-establish a channel's adapter. Token-based platforms reuse their stored
 *  credentials; whatsapp-web re-inits and emits a fresh QR to re-link by scan. */
export async function reconnectChannelAction(
    channelId: string
): Promise<{ error?: string; status?: string }> {
    const user = await requirePermission("inbox.manage");
    try {
        const { status } = await reconnectChannel(user.id, channelId);
        revalidatePath("/admin/email/channels");
        return { status };
    } catch (caught) {
        return {
            error: caught instanceof Error ? caught.message : await say("inbox.errors.reconnectFailed")
        };
    }
}
