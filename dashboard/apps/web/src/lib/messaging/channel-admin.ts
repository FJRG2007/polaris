/**
 * Connecting and managing messaging channels from Integrations > Messaging.
 *
 * Channels are a deployment integration managed by administrators, so these read
 * and change every channel rather than the caller's own; a new one is recorded
 * against the administrator who connected it. Credentials are envelope-encrypted
 * with the master key exactly as before (encryptSecret), and the channels
 * connected under the old Inbox page keep working untouched.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import { loadEnv } from "@polaris/config";
import { encryptSecret } from "@polaris/storage";
import { capabilitiesFor } from "@polaris/messaging";
import { EMAIL_PLATFORM, SMS_PLATFORM } from "@polaris/core";
import type { ChannelCapabilities, ChannelSetup, Platform } from "@polaris/messaging";
import { connectLive, connectRequestFor, disconnectLive, liveState } from "./channel-runtime";

/** Provider config keys whose values are shown back to the admin (none are secret). */
export interface MessagingChannelView {
    id: string;
    platform: string;
    provider: string | null;
    name: string;
    externalId: string | null;
    status: string;
    settings: Record<string, string>;
}

const NOT_MESSAGING = [EMAIL_PLATFORM, SMS_PLATFORM];
const MAX_CHANNELS = 200;

function providerConfig(config: string): Record<string, string> {
    try {
        return (JSON.parse(config) as { providerConfig?: Record<string, string> }).providerConfig ?? {};
    } catch {
        return {};
    }
}

function view(row: {
    id: string;
    platform: string;
    provider: string | null;
    name: string;
    externalId: string | null;
    status: string;
    config: string;
}): MessagingChannelView {
    return {
        id: row.id,
        platform: row.platform,
        provider: row.provider,
        name: row.name,
        externalId: row.externalId,
        status: row.status,
        settings: providerConfig(row.config)
    };
}

const VIEW_SELECT = {
    id: true,
    platform: true,
    provider: true,
    name: true,
    externalId: true,
    status: true,
    config: true
} as const;

/** Every messaging channel on the deployment, oldest first. */
export async function listMessagingChannels(): Promise<MessagingChannelView[]> {
    const rows = await prisma.channel.findMany({
        where: { platform: { notIn: NOT_MESSAGING } },
        orderBy: { createdAt: "asc" },
        take: MAX_CHANNELS,
        select: VIEW_SELECT
    });
    return rows.map(view);
}

async function findChannel(channelId: string) {
    const channel = await prisma.channel.findFirst({
        where: { id: channelId, platform: { notIn: NOT_MESSAGING } }
    });
    if (!channel) throw new Error("Channel not found");
    return channel;
}

/** Store a new channel (credential encrypted), then bring it online. A failure
 *  keeps the row with an "error" status so it can be fixed and retried. */
export async function connectMessagingChannel(
    ownerId: string,
    input: { platform: Platform; provider?: string; name: string; token?: string; config?: Record<string, string> }
): Promise<MessagingChannelView> {
    const token = input.token?.trim();
    const blob = token ? encryptSecret(token, loadEnv().POLARIS_MASTER_KEY) : null;
    const settings = input.config ?? {};
    const channel = await prisma.channel.create({
        data: {
            ownerId,
            platform: input.platform,
            provider: input.provider ?? null,
            name: input.name,
            status: "connecting",
            config: JSON.stringify({
                capabilities: capabilitiesFor(input.platform, input.provider),
                providerConfig: settings
            }),
            encryptedSecret: blob?.ciphertext ?? null,
            secretNonce: blob?.nonce ?? null,
            secretKeyId: blob?.keyId ?? null
        }
    });
    try {
        const result = await connectLive(connectRequestFor(channel));
        const updated = await prisma.channel.update({
            where: { id: channel.id },
            data: {
                status: result.externalId ? "connected" : "connecting",
                externalId: result.externalId ?? null
            },
            select: VIEW_SELECT
        });
        return view(updated);
    } catch (caught) {
        await prisma.channel.update({ where: { id: channel.id }, data: { status: "error" } });
        throw caught instanceof Error ? caught : new Error("Could not connect the channel");
    }
}

/** Bring a channel back from its stored credentials. */
export async function reconnectMessagingChannel(channelId: string): Promise<{ status: string }> {
    const channel = await findChannel(channelId);
    try {
        const result = await connectLive(connectRequestFor(channel));
        const status = result.externalId ? "connected" : "connecting";
        await prisma.channel.update({
            where: { id: channel.id },
            data: { status, ...(result.externalId ? { externalId: result.externalId } : {}) }
        });
        return { status };
    } catch (caught) {
        await prisma.channel.update({ where: { id: channel.id }, data: { status: "error" } });
        throw caught;
    }
}

/** Change a channel's name, credential or settings. A new credential or setting
 *  reconnects it so the change applies at once; an empty token keeps the stored one. */
export async function updateMessagingChannel(
    channelId: string,
    patch: { name?: string; token?: string; config?: Record<string, string> }
): Promise<{ status: string }> {
    const channel = await findChannel(channelId);
    const token = patch.token?.trim();
    const blob = token ? encryptSecret(token, loadEnv().POLARIS_MASTER_KEY) : null;
    let configJson: string | undefined;
    if (patch.config) {
        let capabilities: ChannelCapabilities | undefined;
        try {
            capabilities = (JSON.parse(channel.config) as { capabilities?: ChannelCapabilities }).capabilities;
        } catch {
            capabilities = undefined;
        }
        configJson = JSON.stringify({
            capabilities: capabilities ?? capabilitiesFor(channel.platform as Platform, channel.provider),
            providerConfig: { ...providerConfig(channel.config), ...patch.config }
        });
    }
    await prisma.channel.update({
        where: { id: channel.id },
        data: {
            ...(patch.name?.trim() ? { name: patch.name.trim() } : {}),
            ...(blob ? { encryptedSecret: blob.ciphertext, secretNonce: blob.nonce, secretKeyId: blob.keyId } : {}),
            ...(configJson ? { config: configJson } : {})
        }
    });
    if (blob || configJson) return reconnectMessagingChannel(channelId);
    return { status: channel.status };
}

/** A Telegram channel's bot token, for calls the bot makes about itself. Null
 *  when the channel is not a Telegram bot or holds no token. Server-side only. */
export async function telegramBotToken(channelId: string): Promise<string | null> {
    const channel = await findChannel(channelId);
    if (channel.platform !== "telegram") return null;
    return connectRequestFor(channel).token ?? null;
}

/** Disconnect and forget a channel. */
export async function deleteMessagingChannel(channelId: string): Promise<void> {
    const channel = await findChannel(channelId);
    await disconnectLive(channel.id);
    await prisma.channel.delete({ where: { id: channel.id } });
}

export interface MessagingChannelLiveState {
    status: string;
    qr?: string;
    externalId?: string;
    setup?: ChannelSetup;
}

/** A channel's live state (WhatsApp Web QR, Discord setup), persisting a settled one. */
export async function messagingChannelState(channelId: string): Promise<MessagingChannelLiveState> {
    const channel = await findChannel(channelId);
    const state = liveState(channel.id) ?? { status: "disconnected" as const };
    if (state.status === "connected") {
        await prisma.channel.update({
            where: { id: channel.id },
            data: { status: "connected", ...(state.externalId ? { externalId: state.externalId } : {}) }
        });
    } else if (state.status === "error" || state.status === "disconnected") {
        await prisma.channel.update({ where: { id: channel.id }, data: { status: state.status } });
    }
    return { status: state.status, qr: state.qr, externalId: state.externalId, setup: state.setup };
}
