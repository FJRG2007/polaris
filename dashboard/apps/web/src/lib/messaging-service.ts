/**
 * Messaging control plane. The web is the source of truth: it stores channels
 * (with envelope-encrypted credentials), conversations and normalized messages,
 * and drives the bridge to connect channels and send messages. Inbound events
 * from the bridge are ingested here. Channel secrets use the same AES-256-GCM
 * master key as integrations and storage credentials.
 */

import { loadEnv } from "@polaris/config";
import { prisma } from "@polaris/db";
import { decryptSecret, encryptSecret } from "@polaris/storage";
import { capabilitiesFor } from "@polaris/messaging";
import type { ChannelCapabilities, InteractivePrompt, InboundEvent, Platform } from "@polaris/messaging";
import { bridgeChannelState, bridgeConnectChannel, bridgeDisconnectChannel, bridgeSend } from "./messaging/bridge-client";

export interface ChannelView {
    id: string;
    platform: string;
    provider: string | null;
    name: string;
    externalId: string | null;
    status: string;
    capabilities: ChannelCapabilities | null;
}

export interface ConversationView {
    id: string;
    channelId: string;
    channelName: string;
    /** Channel platform (whatsapp/telegram/discord/slack), for the platform icon. */
    platform: string;
    provider: string | null;
    peerId: string;
    peerName: string | null;
    status: string;
    unread: number;
    lastMessageAt: string | null;
    /** Human agent handling it, if any. */
    assigneeId: string | null;
    /** AI assistant (an InstalledApp) handling it, if any. */
    assistantId: string | null;
}

export interface AgentView {
    id: string;
    name: string;
}

export interface MessageView {
    id: string;
    direction: string;
    kind: string;
    body: string | null;
    ack: string | null;
    selection: string | null;
    senderId: string | null;
    createdAt: string;
}

function parseCapabilities(config: string): ChannelCapabilities | null {
    try {
        const parsed = JSON.parse(config) as { capabilities?: ChannelCapabilities };
        return parsed.capabilities ?? null;
    } catch {
        return null;
    }
}

/** The owner's channels. */
export async function listChannels(ownerId: string): Promise<ChannelView[]> {
    const rows = await prisma.channel.findMany({ where: { ownerId }, orderBy: { createdAt: "asc" } });
    return rows.map((row) => ({
        id: row.id,
        platform: row.platform,
        provider: row.provider,
        name: row.name,
        externalId: row.externalId,
        status: row.status,
        capabilities: parseCapabilities(row.config)
    }));
}

/** Connect a new channel: persist it (encrypting the credential), then bring it
 *  online in the bridge. On failure the row is kept with an "error" status so the
 *  operator can retry. */
export async function connectChannel(
    ownerId: string,
    input: { platform: Platform; provider?: string; name: string; token?: string; config?: Record<string, string> }
): Promise<ChannelView> {
    const env = loadEnv();
    // Clean up a prior failed/in-progress attempt with the same name on this
    // platform, so retrying (e.g. after a QR that errored) does not leave a
    // duplicate channel - one "error" next to the new "connected". Connected
    // channels are never touched.
    await prisma.channel.deleteMany({
        where: {
            ownerId,
            platform: input.platform,
            name: input.name,
            status: { in: ["error", "connecting", "disconnected"] }
        }
    });
    // whatsapp-web logs in by QR and has no upfront token; others do.
    const trimmedToken = input.token?.trim();
    const blob = trimmedToken ? encryptSecret(trimmedToken, env.POLARIS_MASTER_KEY) : null;
    const providerConfig = input.config ?? {};
    const channel = await prisma.channel.create({
        data: {
            ownerId,
            platform: input.platform,
            provider: input.provider ?? null,
            name: input.name,
            status: "connecting",
            config: JSON.stringify({ capabilities: capabilitiesFor(input.platform, input.provider), providerConfig }),
            encryptedSecret: blob?.ciphertext ?? null,
            secretNonce: blob?.nonce ?? null,
            secretKeyId: blob?.keyId ?? null
        }
    });
    try {
        const result = await bridgeConnectChannel({
            channelId: channel.id,
            platform: input.platform,
            provider: input.provider,
            token: trimmedToken,
            config: input.config
        });
        // An adapter that returns its identity is live now (telegram, cloud). One
        // that logs in by QR (whatsapp-web) stays "connecting" until scanned - the
        // UI polls channelState for the QR and the eventual connected status.
        const updated = await prisma.channel.update({
            where: { id: channel.id },
            data: {
                status: result.externalId ? "connected" : "connecting",
                externalId: result.externalId ?? null,
                config: JSON.stringify({ capabilities: result.capabilities, providerConfig })
            }
        });
        return {
            id: updated.id,
            platform: updated.platform,
            provider: updated.provider,
            name: updated.name,
            externalId: updated.externalId,
            status: updated.status,
            capabilities: result.capabilities
        };
    } catch (caught) {
        await prisma.channel.update({ where: { id: channel.id }, data: { status: "error" } });
        throw caught instanceof Error ? caught : new Error("Could not connect the channel");
    }
}

/** Rename a channel (display name only). */
export async function renameChannel(ownerId: string, channelId: string, name: string): Promise<void> {
    const channel = await prisma.channel.findFirst({ where: { id: channelId, ownerId }, select: { id: true } });
    if (!channel) throw new Error("Channel not found");
    const trimmed = name.trim();
    if (!trimmed) throw new Error("Enter a name");
    await prisma.channel.update({ where: { id: channel.id }, data: { name: trimmed } });
}

/** Re-establish a channel's live adapter in the bridge, reusing its stored
 *  credentials (no need to re-enter a token). For token channels this fixes an
 *  errored connection in place; whatsapp-web restores from its session when valid. */
export async function reconnectChannel(ownerId: string, channelId: string): Promise<{ status: string }> {
    const env = loadEnv();
    const channel = await prisma.channel.findFirst({ where: { id: channelId, ownerId } });
    if (!channel) throw new Error("Channel not found");
    const token =
        channel.encryptedSecret && channel.secretNonce && channel.secretKeyId
            ? decryptSecret(
                  {
                      ciphertext: Buffer.from(channel.encryptedSecret),
                      nonce: Buffer.from(channel.secretNonce),
                      keyId: channel.secretKeyId
                  },
                  env.POLARIS_MASTER_KEY
              )
            : undefined;
    let providerConfig: Record<string, string> | undefined;
    try {
        providerConfig = (JSON.parse(channel.config) as { providerConfig?: Record<string, string> }).providerConfig;
    } catch {
        providerConfig = undefined;
    }
    const result = await bridgeConnectChannel({
        channelId: channel.id,
        platform: channel.platform as Platform,
        provider: channel.provider ?? undefined,
        token,
        config: providerConfig
    });
    const status = result.externalId ? "connected" : "connecting";
    await prisma.channel.update({
        where: { id: channel.id },
        data: { status, ...(result.externalId ? { externalId: result.externalId } : {}) }
    });
    return { status };
}

/** Disconnect and forget a channel (and its conversations, by cascade). */
export async function deleteChannel(ownerId: string, channelId: string): Promise<void> {
    const channel = await prisma.channel.findFirst({ where: { id: channelId, ownerId } });
    if (!channel) throw new Error("Channel not found");
    try {
        await bridgeDisconnectChannel(channelId);
    } catch {
        // The bridge may not know it (restarted); removing the record still proceeds.
    }
    await prisma.channel.delete({ where: { id: channel.id } });
}

/** The owner's conversations, most-recently-active first. */
export async function listConversations(ownerId: string): Promise<ConversationView[]> {
    const rows = await prisma.conversation.findMany({
        where: { channel: { ownerId } },
        orderBy: [{ lastMessageAt: "desc" }, { createdAt: "desc" }],
        include: { channel: { select: { name: true, platform: true, provider: true } } },
        take: 200
    });
    return rows.map((row) => ({
        id: row.id,
        channelId: row.channelId,
        channelName: row.channel.name,
        platform: row.channel.platform,
        provider: row.channel.provider,
        peerId: row.peerId,
        peerName: row.peerName,
        status: row.status,
        unread: row.unread,
        lastMessageAt: row.lastMessageAt?.toISOString() ?? null,
        assigneeId: row.assigneeId,
        assistantId: row.assistantId
    }));
}

/** Workspace users who can be assigned a conversation. */
export async function listAgents(): Promise<AgentView[]> {
    const rows = await prisma.user.findMany({
        where: { bannedAt: null },
        select: { id: true, name: true },
        orderBy: { name: "asc" }
    });
    return rows.map((row) => ({ id: row.id, name: row.name }));
}

/** Assign a conversation to a human agent or an AI assistant, and/or set its
 *  status (open/closed/pending). Only the provided fields change. */
export async function assignConversation(
    ownerId: string,
    conversationId: string,
    patch: { assigneeId?: string | null; assistantId?: string | null; status?: string }
): Promise<void> {
    const conversation = await prisma.conversation.findFirst({
        where: { id: conversationId, channel: { ownerId } },
        select: { id: true }
    });
    if (!conversation) throw new Error("Conversation not found");
    await prisma.conversation.update({
        where: { id: conversationId },
        data: {
            ...(patch.assigneeId !== undefined ? { assigneeId: patch.assigneeId } : {}),
            ...(patch.assistantId !== undefined ? { assistantId: patch.assistantId } : {}),
            ...(patch.status !== undefined ? { status: patch.status } : {})
        }
    });
}

/** A conversation's messages, oldest first; marks it read. */
export async function getConversationMessages(ownerId: string, conversationId: string): Promise<MessageView[]> {
    const conversation = await prisma.conversation.findFirst({
        where: { id: conversationId, channel: { ownerId } },
        select: { id: true }
    });
    if (!conversation) throw new Error("Conversation not found");
    const rows = await prisma.message.findMany({
        where: { conversationId },
        orderBy: { createdAt: "asc" },
        take: 500
    });
    if (rows.length > 0) await prisma.conversation.update({ where: { id: conversationId }, data: { unread: 0 } });
    return rows.map((row) => ({
        id: row.id,
        direction: row.direction,
        kind: row.kind,
        body: row.body,
        ack: row.ack,
        selection: readSelection(row.payload),
        senderId: row.senderId,
        createdAt: row.createdAt.toISOString()
    }));
}

function readSelection(payload: string | null): string | null {
    if (!payload) return null;
    try {
        return (JSON.parse(payload) as { selection?: string }).selection ?? null;
    } catch {
        return null;
    }
}

/** Send a message in a conversation: persist it, then hand it to the bridge. */
export async function sendConversationMessage(
    ownerId: string,
    conversationId: string,
    senderId: string,
    content: { text?: string; interactive?: InteractivePrompt }
): Promise<MessageView> {
    const conversation = await prisma.conversation.findFirst({
        where: { id: conversationId, channel: { ownerId } },
        include: { channel: { select: { id: true } } }
    });
    if (!conversation) throw new Error("Conversation not found");

    const message = await prisma.message.create({
        data: {
            conversationId,
            direction: "outbound",
            kind: content.interactive ? "interactive" : "text",
            body: content.text ?? content.interactive?.text ?? null,
            payload: content.interactive ? JSON.stringify({ interactive: content.interactive }) : null,
            ack: "sent",
            senderId
        }
    });
    await prisma.conversation.update({ where: { id: conversationId }, data: { lastMessageAt: new Date() } });

    try {
        const result = await bridgeSend(conversation.channel.id, {
            peerId: conversation.peerId,
            text: content.text,
            interactive: content.interactive
        });
        if (result.externalId) {
            await prisma.message.update({ where: { id: message.id }, data: { externalId: result.externalId } });
        }
    } catch (caught) {
        await prisma.message.update({ where: { id: message.id }, data: { ack: "failed" } });
        throw caught instanceof Error ? caught : new Error("Could not send the message");
    }

    return {
        id: message.id,
        direction: message.direction,
        kind: message.kind,
        body: message.body,
        ack: message.ack,
        selection: null,
        senderId: message.senderId,
        createdAt: message.createdAt.toISOString()
    };
}

/** Normalize a peer id to what the platform's adapter expects. WhatsApp wants a
 *  JID (<digits>@c.us) - a plain phone number is converted; other platforms take
 *  the id as entered. */
function normalizePeerId(platform: string, raw: string): string {
    const value = raw.trim();
    if (platform === "whatsapp" && value && !value.includes("@")) {
        const digits = value.replace(/\D/g, "");
        return digits ? `${digits}@c.us` : value;
    }
    return value;
}

/** Start a new outbound conversation: upsert the conversation for (channel, peer)
 *  and send the first message through the bridge. Returns the conversation id so
 *  the inbox can open it. */
export async function startConversation(
    ownerId: string,
    senderId: string,
    input: { channelId: string; peerId: string; peerName?: string; text: string }
): Promise<{ conversationId: string }> {
    const channel = await prisma.channel.findFirst({
        where: { id: input.channelId, ownerId },
        select: { id: true, platform: true, status: true }
    });
    if (!channel) throw new Error("Channel not found");
    if (channel.status !== "connected") throw new Error("Connect the channel before starting a chat");
    const peerId = normalizePeerId(channel.platform, input.peerId);
    if (!peerId) throw new Error("Enter who to message");

    const peerName = input.peerName?.trim() || null;
    const conversation = await prisma.conversation.upsert({
        where: { channelId_peerId: { channelId: channel.id, peerId } },
        create: { channelId: channel.id, peerId, peerName, status: "open" },
        update: peerName ? { peerName } : {}
    });
    await sendConversationMessage(ownerId, conversation.id, senderId, { text: input.text });
    return { conversationId: conversation.id };
}

export interface ContactView {
    id: string;
    name: string;
    platform: string;
    peerId: string;
    note: string | null;
}

/** The owner's saved contacts, alphabetical. */
export async function listContacts(ownerId: string): Promise<ContactView[]> {
    const rows = await prisma.contact.findMany({ where: { ownerId }, orderBy: { name: "asc" } });
    return rows.map((row) => ({ id: row.id, name: row.name, platform: row.platform, peerId: row.peerId, note: row.note }));
}

/** Create or update a contact (unique per owner + platform + peer). */
export async function createContact(
    ownerId: string,
    input: { name: string; platform: Platform; peerId: string; note?: string }
): Promise<ContactView> {
    const peerId = normalizePeerId(input.platform, input.peerId);
    if (!peerId) throw new Error("Enter the contact's id or number");
    const note = input.note?.trim() || null;
    const row = await prisma.contact.upsert({
        where: { ownerId_platform_peerId: { ownerId, platform: input.platform, peerId } },
        create: { ownerId, name: input.name.trim(), platform: input.platform, peerId, note },
        update: { name: input.name.trim(), note }
    });
    return { id: row.id, name: row.name, platform: row.platform, peerId: row.peerId, note: row.note };
}

/** Remove a saved contact. */
export async function deleteContact(ownerId: string, id: string): Promise<void> {
    const row = await prisma.contact.findFirst({ where: { id, ownerId }, select: { id: true } });
    if (!row) throw new Error("Contact not found");
    await prisma.contact.delete({ where: { id: row.id } });
}

/** Ingest a normalized inbound event from the bridge: upsert the conversation and
 *  persist the message. Called only by the internal ingest route. */
export async function ingestInbound(event: InboundEvent): Promise<void> {
    const channel = await prisma.channel.findFirst({ where: { id: event.channelId }, select: { id: true } });
    if (!channel) return;
    const conversation = await prisma.conversation.upsert({
        where: { channelId_peerId: { channelId: channel.id, peerId: event.peerId } },
        create: {
            channelId: channel.id,
            peerId: event.peerId,
            peerName: event.peerName ?? null,
            lastMessageAt: new Date(event.at),
            unread: 1
        },
        update: {
            peerName: event.peerName ?? undefined,
            lastMessageAt: new Date(event.at),
            unread: { increment: 1 }
        }
    });
    await prisma.message.create({
        data: {
            conversationId: conversation.id,
            direction: "inbound",
            externalId: event.externalId ?? null,
            kind: event.kind,
            body: event.body ?? null,
            payload: event.selection ? JSON.stringify({ selection: event.selection }) : null
        }
    });
}

/** Resolve the WhatsApp Cloud channel bound to a Meta phone-number id, for the
 *  webhook. Provider config is stored as JSON, so match in memory (few channels). */
export async function findCloudChannelByPhoneNumberId(phoneNumberId: string): Promise<string | null> {
    const rows = await prisma.channel.findMany({
        where: { platform: "whatsapp", provider: "whatsapp-cloud" },
        select: { id: true, config: true }
    });
    for (const row of rows) {
        try {
            const parsed = JSON.parse(row.config) as { providerConfig?: { phoneNumberId?: string } };
            if (parsed.providerConfig?.phoneNumberId === phoneNumberId) return row.id;
        } catch {
            // Skip a malformed config row.
        }
    }
    return null;
}

/** Resolve a channel by its platform + platform-side id (e.g. Slack team id), for
 *  webhook routing. */
export async function findChannelByExternalId(platform: string, externalId: string): Promise<string | null> {
    const channel = await prisma.channel.findFirst({ where: { platform, externalId }, select: { id: true } });
    return channel?.id ?? null;
}

export interface ChannelLiveState {
    status: string;
    qr?: string;
    externalId?: string;
}

/** Poll the bridge for a channel's live state (QR / connected), persisting a
 *  connected or errored result. Drives the whatsapp-web QR onboarding UI. */
export async function channelState(ownerId: string, channelId: string): Promise<ChannelLiveState> {
    const channel = await prisma.channel.findFirst({ where: { id: channelId, ownerId }, select: { id: true } });
    if (!channel) throw new Error("Channel not found");
    const state = await bridgeChannelState(channelId);
    if (state.status === "connected") {
        await prisma.channel.update({
            where: { id: channelId },
            data: { status: "connected", ...(state.externalId ? { externalId: state.externalId } : {}) }
        });
    } else if (state.status === "error" || state.status === "disconnected") {
        await prisma.channel.update({ where: { id: channelId }, data: { status: state.status } });
    }
    return { status: state.status, qr: state.qr, externalId: state.externalId };
}

/** Re-establish live adapters in the bridge for channels the DB considers up. The
 *  bridge holds adapters in memory, so a bridge (or web) restart leaves a channel
 *  "connected" in the DB but dead at the bridge; this reconnects any whose bridge
 *  state is missing. whatsapp-web restores from its LocalAuth session without a new
 *  QR when the session is still valid. Best-effort and idempotent - channels the
 *  bridge already runs are left alone, so it never churns a healthy adapter. */
export async function reconcileChannels(): Promise<void> {
    const env = loadEnv();
    const channels = await prisma.channel.findMany({ where: { status: { in: ["connected", "connecting"] } } });
    for (const channel of channels) {
        try {
            await bridgeChannelState(channel.id);
            // The bridge already runs an adapter for this channel (in any state), so
            // leave it. Never re-initialize a live whatsapp-web client just because it
            // reports an error - a fresh init re-links the device, which WhatsApp flags
            // as suspicious. Only (re)establish a channel whose adapter is truly gone.
            continue;
        } catch {
            // Adapter absent (404) or bridge unreachable: (re)establish it below.
        }
        try {
            const token =
                channel.encryptedSecret && channel.secretNonce && channel.secretKeyId
                    ? decryptSecret(
                          {
                              ciphertext: Buffer.from(channel.encryptedSecret),
                              nonce: Buffer.from(channel.secretNonce),
                              keyId: channel.secretKeyId
                          },
                          env.POLARIS_MASTER_KEY
                      )
                    : undefined;
            let providerConfig: Record<string, string> | undefined;
            try {
                providerConfig = (JSON.parse(channel.config) as { providerConfig?: Record<string, string> }).providerConfig;
            } catch {
                providerConfig = undefined;
            }
            await bridgeConnectChannel({
                channelId: channel.id,
                platform: channel.platform as Platform,
                provider: channel.provider ?? undefined,
                token,
                config: providerConfig
            });
        } catch (caught) {
            console.error(
                `reconcileChannels: could not re-establish ${channel.id}:`,
                caught instanceof Error ? caught.message : caught
            );
        }
    }
}

/** Run channel reconcile at startup and on an interval, so channels self-heal
 *  after a bridge or web restart without any manual reconnection. */
export function startChannelReconcile(): void {
    const tick = () =>
        void reconcileChannels().catch((error) => console.error("polaris: channel reconcile failed:", error));
    tick();
    setInterval(tick, 60_000);
}
