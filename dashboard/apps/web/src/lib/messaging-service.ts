/**
 * Messaging control plane. The web is the source of truth: it stores channels
 * (with envelope-encrypted credentials), conversations and normalized messages,
 * and drives the bridge to connect channels and send messages. Inbound events
 * from the bridge are ingested here. Channel secrets use the same AES-256-GCM
 * master key as integrations and storage credentials.
 */

import { loadEnv } from "@polaris/config";
import { prisma } from "@polaris/db";
import { encryptSecret } from "@polaris/storage";
import { capabilitiesFor } from "@polaris/messaging";
import type { ChannelCapabilities, InteractivePrompt, InboundEvent, Platform } from "@polaris/messaging";
import { bridgeConnectChannel, bridgeDisconnectChannel, bridgeSend } from "./messaging/bridge-client";

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
    peerId: string;
    peerName: string | null;
    status: string;
    unread: number;
    lastMessageAt: string | null;
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
    input: { platform: Platform; provider?: string; name: string; token: string }
): Promise<ChannelView> {
    const env = loadEnv();
    const blob = encryptSecret(input.token.trim(), env.POLARIS_MASTER_KEY);
    const channel = await prisma.channel.create({
        data: {
            ownerId,
            platform: input.platform,
            provider: input.provider ?? null,
            name: input.name,
            status: "connecting",
            config: JSON.stringify({ capabilities: capabilitiesFor(input.platform, input.provider) }),
            encryptedSecret: blob.ciphertext,
            secretNonce: blob.nonce,
            secretKeyId: blob.keyId
        }
    });
    try {
        const result = await bridgeConnectChannel({
            channelId: channel.id,
            platform: input.platform,
            provider: input.provider,
            token: input.token.trim()
        });
        const updated = await prisma.channel.update({
            where: { id: channel.id },
            data: {
                status: "connected",
                externalId: result.externalId ?? null,
                config: JSON.stringify({ capabilities: result.capabilities })
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
        include: { channel: { select: { name: true } } },
        take: 200
    });
    return rows.map((row) => ({
        id: row.id,
        channelId: row.channelId,
        channelName: row.channel.name,
        peerId: row.peerId,
        peerName: row.peerName,
        status: row.status,
        unread: row.unread,
        lastMessageAt: row.lastMessageAt?.toISOString() ?? null
    }));
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
