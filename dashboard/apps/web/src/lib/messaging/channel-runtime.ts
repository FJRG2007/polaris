/**
 * The live side of messaging channels, inside the web process. One adapter per
 * connected channel, keyed by channel id, kept on `globalThis` so a module that
 * is evaluated twice (dev reloads, separate route chunks) still sees one
 * connection per channel per process.
 *
 * Connecting is idempotent: an existing adapter is torn down first. Sending
 * through a channel whose adapter is not running starts it from the stored
 * credentials, so a restart never needs a manual reconnect before the next
 * alert or sign-in code. The heavier adapters (discord.js, Baileys for WhatsApp
 * Web) are imported only when a channel of theirs is connected.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import { loadEnv } from "@polaris/config";
import { EMAIL_PLATFORM } from "@polaris/core";
import { decryptSecret } from "@polaris/storage";
import { capabilitiesFor } from "@polaris/messaging";
import { hasWhatsAppSession } from "./whatsapp-session";
import type {
    AdapterContext,
    ChannelAdapter,
    ChannelCapabilities,
    ChannelState,
    InteractivePrompt,
    Platform,
    SendResult
} from "@polaris/messaging";

export interface ConnectRequest {
    channelId: string;
    platform: Platform;
    provider?: string;
    token?: string;
    config?: Record<string, string>;
}

interface Runtime {
    adapters: Map<string, ChannelAdapter>;
    /** Lazy starts in flight, so two sends at once start one adapter. */
    starting: Map<string, Promise<ChannelAdapter>>;
}

const RUNTIME_KEY = Symbol.for("polaris.messaging.channelRuntime");

function runtime(): Runtime {
    const holder = globalThis as { [RUNTIME_KEY]?: Runtime };
    holder[RUNTIME_KEY] ??= { adapters: new Map(), starting: new Map() };
    return holder[RUNTIME_KEY];
}

async function buildAdapter(request: ConnectRequest, context: AdapterContext): Promise<ChannelAdapter> {
    switch (request.platform) {
        case "telegram": {
            if (!request.token) throw new Error("Telegram needs a bot token");
            const { TelegramAdapter } = await import("./adapters/telegram");
            return new TelegramAdapter(request.token);
        }
        case "whatsapp": {
            if (request.provider === "whatsapp-cloud") {
                if (!request.token) throw new Error("WhatsApp Cloud needs an access token");
                const phoneNumberId = request.config?.phoneNumberId;
                if (!phoneNumberId) throw new Error("WhatsApp Cloud needs a phone number ID");
                const { WhatsAppCloudAdapter } = await import("./adapters/whatsapp-cloud");
                return new WhatsAppCloudAdapter(request.token, phoneNumberId, context);
            }
            const { WhatsAppWebAdapter } = await import("./adapters/whatsapp-web");
            return new WhatsAppWebAdapter(request.channelId, context);
        }
        case "discord": {
            if (request.provider === "discord-webhook") {
                if (!request.token) throw new Error("A Discord webhook needs its URL");
                const { DiscordWebhookAdapter } = await import("./adapters/discord-webhook");
                return new DiscordWebhookAdapter(request.token, context);
            }
            if (!request.token) throw new Error("Discord needs a bot token");
            const { DiscordAdapter } = await import("./adapters/discord");
            return new DiscordAdapter(request.token, request.channelId, context);
        }
        case "slack": {
            if (request.provider === "slack-webhook") {
                if (!request.token) throw new Error("A Slack webhook needs its URL");
                const { SlackWebhookAdapter } = await import("./adapters/slack-webhook");
                return new SlackWebhookAdapter(request.token, context);
            }
            if (!request.token) throw new Error("Slack needs a bot token");
            const { SlackAdapter } = await import("./adapters/slack");
            return new SlackAdapter(request.token, context);
        }
        default:
            throw new Error(`The ${request.platform} channel is not available`);
    }
}

/** Bring a channel online in this process, replacing any adapter it had. */
export async function connectLive(
    request: ConnectRequest
): Promise<{ externalId?: string; capabilities: ChannelCapabilities }> {
    const { adapters } = runtime();
    await disconnectLive(request.channelId);
    const context: AdapterContext = {
        channelId: request.channelId,
        // Nothing reads replies; adapters that still report them are ignored.
        onInbound: () => undefined,
        log: (message) => console.info(`[messaging:${request.platform}:${request.channelId}] ${message}`)
    };
    const adapter = await buildAdapter(request, context);
    adapters.set(request.channelId, adapter);
    try {
        const result = await adapter.connect();
        return {
            externalId: result.externalId,
            capabilities: capabilitiesFor(request.platform, request.provider)
        };
    } catch (caught) {
        // A failed adapter is not left behind looking connected.
        if (adapters.get(request.channelId) === adapter) adapters.delete(request.channelId);
        await adapter.disconnect().catch(() => undefined);
        throw caught;
    }
}

/** Stop a channel's adapter, if it runs here. */
export async function disconnectLive(channelId: string): Promise<void> {
    const { adapters } = runtime();
    const adapter = adapters.get(channelId);
    if (!adapter) return;
    adapters.delete(channelId);
    await adapter.disconnect().catch(() => undefined);
}

/** Stop every adapter (shutdown), so WhatsApp Web closes its session cleanly. */
export async function disconnectAllLive(): Promise<void> {
    await Promise.all([...runtime().adapters.keys()].map((id) => disconnectLive(id)));
}

/** The live state of a channel's adapter, or null when none runs here. */
export function liveState(channelId: string): ChannelState | null {
    const adapter = runtime().adapters.get(channelId);
    if (!adapter) return null;
    return adapter.getState ? adapter.getState() : { status: "connected" };
}

/** The stored row's credentials, decrypted, as a connect request. */
export function connectRequestFor(channel: {
    id: string;
    platform: string;
    provider: string | null;
    config: string;
    encryptedSecret: Uint8Array | null;
    secretNonce: Uint8Array | null;
    secretKeyId: string | null;
}): ConnectRequest {
    const token =
        channel.encryptedSecret && channel.secretNonce && channel.secretKeyId
            ? decryptSecret(
                  {
                      ciphertext: Buffer.from(channel.encryptedSecret),
                      nonce: Buffer.from(channel.secretNonce),
                      keyId: channel.secretKeyId
                  },
                  loadEnv().POLARIS_MASTER_KEY
              )
            : undefined;
    let config: Record<string, string> | undefined;
    try {
        config = (JSON.parse(channel.config) as { providerConfig?: Record<string, string> }).providerConfig;
    } catch {
        config = undefined;
    }
    return {
        channelId: channel.id,
        platform: channel.platform as Platform,
        provider: channel.provider ?? undefined,
        token,
        config
    };
}

const NOT_LINKED = "This channel is not linked. Scan its QR code again in Admin > Channels.";

/** How long a send waits for a WhatsApp Web session to finish restoring. */
const RESTORE_WAIT_MS = 45_000;

function isWhatsAppWeb(channel: { platform: string; provider: string | null }): boolean {
    return channel.platform === "whatsapp" && channel.provider !== "whatsapp-cloud";
}

/** Start a channel's adapter from its stored row, once per process. */
async function ensureLive(channelId: string): Promise<ChannelAdapter> {
    const state = runtime();
    const running = state.adapters.get(channelId);
    if (running) return running;
    const inFlight = state.starting.get(channelId);
    if (inFlight) return inFlight;
    const start = (async () => {
        const channel = await prisma.channel.findUnique({ where: { id: channelId } });
        if (!channel || channel.platform === EMAIL_PLATFORM) throw new Error("Channel not found");
        // A WhatsApp Web device with no session here can only show a QR, which
        // nobody is watching during a send: refuse instead of opening a browser.
        if (isWhatsAppWeb(channel) && !hasWhatsAppSession(channel.id)) throw new Error(NOT_LINKED);
        await connectLive(connectRequestFor(channel));
        const adapter = state.adapters.get(channelId);
        if (!adapter) throw new Error("The channel could not be started");
        return adapter;
    })();
    state.starting.set(channelId, start);
    try {
        return await start;
    } finally {
        state.starting.delete(channelId);
    }
}

/** Send through a channel, starting its adapter first when it is not running. */
export async function sendThroughChannel(
    channelId: string,
    message: { peerId: string; text?: string; interactive?: InteractivePrompt }
): Promise<SendResult> {
    const adapter = await ensureLive(channelId);
    // A WhatsApp Web session restores in the background after a start; the first
    // send after a restart waits for it rather than failing on a page not ready.
    const deadline = Date.now() + RESTORE_WAIT_MS;
    while (adapter.getState?.().status === "connecting" && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 500));
    }
    const status = adapter.getState?.().status;
    // A WhatsApp Web device that is not linked cannot send; say so rather than
    // letting the browser session fail somewhere deeper.
    if (status === "qr" || status === "disconnected" || status === "error") throw new Error(NOT_LINKED);
    if (status === "connecting") throw new Error("This channel is still starting. Try again in a minute.");
    return adapter.send(message);
}
