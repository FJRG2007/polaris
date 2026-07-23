/**
 * Typed client for the messaging bridge's HTTP API. The bridge holds the live
 * adapter connections; the web calls it to connect a channel, send a message, or
 * disconnect. Configured by env (internal network only): MESSAGING_BRIDGE_URL and
 * the shared MESSAGING_BRIDGE_TOKEN bearer. Never called from the client.
 */

import type { ChannelCapabilities, InteractivePrompt, Platform } from "@polaris/messaging";

const BRIDGE_URL = (process.env.MESSAGING_BRIDGE_URL ?? "").replace(/\/+$/, "");
const BRIDGE_TOKEN = process.env.MESSAGING_BRIDGE_TOKEN ?? "";

/** Whether a bridge is configured; the UI hides channel actions when it is not. */
export function bridgeConfigured(): boolean {
    return BRIDGE_URL.length > 0;
}

async function call<T>(path: string, init: RequestInit): Promise<T> {
    if (!BRIDGE_URL) throw new Error("The messaging bridge is not configured");
    const response = await fetch(`${BRIDGE_URL}${path}`, {
        ...init,
        headers: { "content-type": "application/json", authorization: `Bearer ${BRIDGE_TOKEN}`, ...init.headers }
    });
    const data = (await response.json().catch(() => ({}))) as { error?: string } & T;
    if (!response.ok) throw new Error(data.error ?? `Bridge request to ${path} failed`);
    return data;
}

export async function bridgeConnectChannel(input: {
    channelId: string;
    platform: Platform;
    provider?: string;
    token: string;
}): Promise<{ externalId?: string; capabilities: ChannelCapabilities }> {
    return call("/channels", { method: "POST", body: JSON.stringify(input) });
}

export async function bridgeDisconnectChannel(channelId: string): Promise<void> {
    await call(`/channels/${encodeURIComponent(channelId)}`, { method: "DELETE" });
}

export async function bridgeSend(
    channelId: string,
    message: { peerId: string; text?: string; interactive?: InteractivePrompt }
): Promise<{ externalId?: string }> {
    return call(`/channels/${encodeURIComponent(channelId)}/send`, { method: "POST", body: JSON.stringify(message) });
}
