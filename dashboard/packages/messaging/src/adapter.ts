/**
 * The channel-adapter contract. One implementation per platform/provider lives in
 * the bridge; everything above speaks only this interface, so adding a platform
 * never touches the inbox or the AI assistants.
 */

import type { ChannelCapabilities, InboundMessage, OutboundMessage } from "./types.js";

export interface AdapterContext {
    channelId: string;
    /** The bridge's callback for a message arriving from the platform. */
    onInbound: (message: InboundMessage) => void;
    /** Structured logging hook (adapter name + channel are prefixed by the bridge). */
    log: (message: string) => void;
}

export interface SendResult {
    /** Platform-side id of the sent message, when the platform returns one. */
    externalId?: string;
}

export interface ChannelAdapter {
    readonly capabilities: ChannelCapabilities;
    /** Start receiving; resolves with the platform-side identity once connected. */
    connect(): Promise<{ externalId?: string }>;
    /** Stop receiving and release resources. Must be idempotent. */
    disconnect(): Promise<void>;
    send(message: OutboundMessage): Promise<SendResult>;
}

/** Factory a platform module registers under its `Platform` key. */
export type AdapterFactory = (options: { token: string; provider?: string }, context: AdapterContext) => ChannelAdapter;
