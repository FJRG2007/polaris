/**
 * Live adapter registry: one running ChannelAdapter per connected channel, keyed
 * by channelId. Connecting is idempotent (an existing adapter is torn down first),
 * so the web can re-sync a channel without leaking pollers.
 */

import type { AdapterContext, ChannelAdapter, InboundMessage } from "@polaris/messaging";
import type { ConnectChannelRequest } from "@polaris/messaging";
import { DiscordAdapter } from "./adapters/discord.js";
import { SlackAdapter } from "./adapters/slack.js";
import { TelegramAdapter } from "./adapters/telegram.js";
import { WhatsAppCloudAdapter } from "./adapters/whatsapp-cloud.js";
import { WhatsAppWebAdapter } from "./adapters/whatsapp-web.js";

export class AdapterRegistry {
    private readonly adapters = new Map<string, ChannelAdapter>();
    private readonly onInbound: (message: InboundMessage) => void;

    constructor(onInbound: (message: InboundMessage) => void) {
        this.onInbound = onInbound;
    }

    private build(request: ConnectChannelRequest, context: AdapterContext): ChannelAdapter {
        switch (request.platform) {
            case "telegram": {
                if (!request.token) throw new Error("Telegram needs a bot token");
                return new TelegramAdapter(request.token, context);
            }
            case "whatsapp": {
                if (request.provider === "whatsapp-cloud") {
                    if (!request.token) throw new Error("WhatsApp Cloud needs an access token");
                    const phoneNumberId = request.config?.phoneNumberId;
                    if (!phoneNumberId) throw new Error("WhatsApp Cloud needs a phoneNumberId in config");
                    return new WhatsAppCloudAdapter(request.token, phoneNumberId, context);
                }
                return new WhatsAppWebAdapter(request.channelId, context);
            }
            case "discord": {
                if (!request.token) throw new Error("Discord needs a bot token");
                return new DiscordAdapter(request.token, request.channelId, context);
            }
            case "slack": {
                if (!request.token) throw new Error("Slack needs a bot token");
                return new SlackAdapter(request.token, context);
            }
            default:
                throw new Error(`The ${request.platform} adapter is not available yet`);
        }
    }

    async connect(request: ConnectChannelRequest): Promise<{ externalId?: string }> {
        await this.disconnect(request.channelId);
        const context: AdapterContext = {
            channelId: request.channelId,
            onInbound: this.onInbound,
            log: (message) => console.log(`[${request.platform}:${request.channelId}] ${message}`)
        };
        const adapter = this.build(request, context);
        this.adapters.set(request.channelId, adapter);
        return adapter.connect();
    }

    async disconnect(channelId: string): Promise<void> {
        const adapter = this.adapters.get(channelId);
        if (!adapter) return;
        this.adapters.delete(channelId);
        await adapter.disconnect();
    }

    /** Tear down every live adapter. Used on graceful shutdown so heavy adapters
     *  (whatsapp-web's Chromium) close cleanly and flush their session, instead of
     *  being killed mid-write - which would force a QR re-scan on the next start. */
    async disconnectAll(): Promise<void> {
        const ids = [...this.adapters.keys()];
        await Promise.all(ids.map((id) => this.disconnect(id)));
    }

    get(channelId: string): ChannelAdapter | undefined {
        return this.adapters.get(channelId);
    }
}
