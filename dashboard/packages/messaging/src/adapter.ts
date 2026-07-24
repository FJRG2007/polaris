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

/** Onboarding/connection state, for adapters that log in asynchronously (a QR to
 *  scan, a pairing code). Synchronous adapters report "connected" from connect(). */
export interface ChannelState {
    status: "connecting" | "qr" | "connected" | "disconnected" | "error";
    /** A QR image data URL to scan while status is "qr" (whatsapp-web). */
    qr?: string;
    externalId?: string;
    detail?: string;
}

/** A group of addressable send targets a bot can reach, for a recipient picker in
 *  the UI (e.g. a Discord server and its text channels). Recipients that are not
 *  enumerable (a phone number, a user to DM) are entered by hand instead. */
export interface TargetGroup {
    /** Group id (e.g. Discord guild id); informational, not a send target. */
    id: string;
    name: string;
    targets: { id: string; name: string }[];
}

export interface ChannelAdapter {
    readonly capabilities: ChannelCapabilities;
    /** Start receiving; resolves with the platform-side identity once connected.
     *  Async-login adapters (QR) resolve immediately and report progress via
     *  getState(). */
    connect(): Promise<{ externalId?: string }>;
    /** Stop receiving and release resources. Must be idempotent. */
    disconnect(): Promise<void>;
    send(message: OutboundMessage): Promise<SendResult>;
    /** Current state, for async-login adapters. Absent = "connected" once connect() resolved. */
    getState?(): ChannelState;
    /** Enumerate addressable targets grouped (server -> channels), for platforms
     *  whose recipients are discoverable (Discord). Absent where they are not. */
    listTargets?(): Promise<TargetGroup[]>;
}

/** Factory a platform module registers under its `Platform` key. */
export type AdapterFactory = (
    options: { token?: string; provider?: string; config?: Record<string, string> },
    context: AdapterContext
) => ChannelAdapter;
