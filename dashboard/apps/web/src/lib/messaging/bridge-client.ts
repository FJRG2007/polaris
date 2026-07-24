/**
 * Typed client for the messaging bridge's HTTP API. The bridge holds the live
 * adapter connections; the web calls it to connect a channel, send a message, or
 * disconnect. The bridge's URL and bearer token are resolved per call (see
 * bridge-endpoint): a marketplace-installed bridge, or a static-env one for
 * operators running their own. Never called from the client.
 */

import type {
    ChannelCapabilities,
    ChannelState,
    InteractivePrompt,
    Platform,
    TargetGroup
} from "@polaris/messaging";
import { isBridgeConfigured, resolveBridge } from "./bridge-endpoint";

/** Whether a bridge is configured; the UI hides channel actions when it is not. */
export async function bridgeConfigured(): Promise<boolean> {
    return isBridgeConfigured();
}

async function call<T>(path: string, init: RequestInit): Promise<T> {
    const endpoint = await resolveBridge();
    if (!endpoint) throw new Error("The messaging bridge is not configured");
    const response = await fetch(`${endpoint.baseUrl}${path}`, {
        ...init,
        headers: {
            "content-type": "application/json",
            authorization: `Bearer ${endpoint.token}`,
            ...init.headers
        }
    });
    const data = (await response.json().catch(() => ({}))) as { error?: string } & T;
    if (!response.ok) throw new Error(data.error ?? `Bridge request to ${path} failed`);
    return data;
}

export async function bridgeConnectChannel(input: {
    channelId: string;
    platform: Platform;
    provider?: string;
    token?: string;
    config?: Record<string, string>;
}): Promise<{ externalId?: string; capabilities: ChannelCapabilities }> {
    return call("/channels", { method: "POST", body: JSON.stringify(input) });
}

export async function bridgeDisconnectChannel(channelId: string): Promise<void> {
    await call(`/channels/${encodeURIComponent(channelId)}`, { method: "DELETE" });
}

/** Current onboarding/connection state (whatsapp-web reports its QR here). */
export async function bridgeChannelState(channelId: string): Promise<ChannelState> {
    return call(`/channels/${encodeURIComponent(channelId)}/state`, { method: "GET" });
}

export async function bridgeSend(
    channelId: string,
    message: { peerId: string; text?: string; interactive?: InteractivePrompt }
): Promise<{ externalId?: string }> {
    return call(`/channels/${encodeURIComponent(channelId)}/send`, {
        method: "POST",
        body: JSON.stringify(message)
    });
}

/** Addressable send targets grouped (server -> channels) for a channel whose
 *  adapter enumerates them (Discord). Soft-fails to an empty list so the UI falls
 *  back to manual entry when the bridge is older or the adapter lists nothing. */
export async function bridgeListTargets(channelId: string): Promise<TargetGroup[]> {
    try {
        const { groups } = await call<{ groups: TargetGroup[] }>(
            `/channels/${encodeURIComponent(channelId)}/targets`,
            { method: "GET" }
        );
        return Array.isArray(groups) ? groups : [];
    } catch {
        return [];
    }
}
