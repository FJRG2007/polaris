/**
 * Discord webhook adapter: send-only. Posts to a Discord Incoming Webhook URL with
 * no bot and no gateway, so it cannot receive - useful for one-way alerts to a
 * channel (what the Watch app targets) without running a bot. Interactive prompts
 * degrade to their text, since buttons need a bot application.
 */

import { capabilitiesFor } from "@polaris/messaging";
import type { AdapterContext, ChannelAdapter, OutboundMessage, SendResult } from "@polaris/messaging";

const WEBHOOK_URL = /^https:\/\/(discord\.com|discordapp\.com|ptb\.discord\.com|canary\.discord\.com)\/api\/(v\d+\/)?webhooks\/\d+\//;

export class DiscordWebhookAdapter implements ChannelAdapter {
    readonly capabilities = capabilitiesFor("discord", "discord-webhook");
    private readonly url: string;

    constructor(url: string, _ctx: AdapterContext) {
        this.url = url.trim();
    }

    async connect(): Promise<{ externalId?: string }> {
        // A webhook has no live session; validate the URL shape and report ready.
        if (!WEBHOOK_URL.test(this.url)) {
            throw new Error("That does not look like a Discord webhook URL");
        }
        return { externalId: "webhook" };
    }

    async disconnect(): Promise<void> {
        // Nothing to tear down.
    }

    async send(message: OutboundMessage): Promise<SendResult> {
        const content = message.interactive?.text ?? message.text ?? "";
        // wait=true so Discord returns the created message (and its id).
        const response = await fetch(`${this.url}?wait=true`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ content })
        });
        if (!response.ok) {
            throw new Error(`Discord webhook failed (${response.status})`);
        }
        const data = (await response.json().catch(() => ({}))) as { id?: string };
        return { externalId: data.id };
    }
}
