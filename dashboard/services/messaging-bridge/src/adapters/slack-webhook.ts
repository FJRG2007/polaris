/**
 * Slack webhook adapter: send-only. Posts to a Slack Incoming Webhook URL - no app
 * token, no socket, so it cannot receive - for one-way alerts to a channel (what the
 * Watch app targets). Interactive prompts degrade to their text, since Block Kit
 * actions need a full Slack app.
 */

import { capabilitiesFor } from "@polaris/messaging";
import type { AdapterContext, ChannelAdapter, OutboundMessage, SendResult } from "@polaris/messaging";

const WEBHOOK_URL = /^https:\/\/hooks\.slack\.com\/services\//;

export class SlackWebhookAdapter implements ChannelAdapter {
    readonly capabilities = capabilitiesFor("slack", "slack-webhook");
    private readonly url: string;

    constructor(url: string, _ctx: AdapterContext) {
        this.url = url.trim();
    }

    async connect(): Promise<{ externalId?: string }> {
        if (!WEBHOOK_URL.test(this.url)) {
            throw new Error("That does not look like a Slack incoming webhook URL");
        }
        return { externalId: "webhook" };
    }

    async disconnect(): Promise<void> {
        // Nothing to tear down.
    }

    async send(message: OutboundMessage): Promise<SendResult> {
        const text = message.interactive
            ? [
                  message.interactive.text,
                  ...message.interactive.options.map((option, index) => `${index + 1}. ${option.label}`)
              ].join("\n")
            : message.text ?? "";
        const response = await fetch(this.url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ text })
        });
        // Slack replies with a plain "ok" body and no message id.
        if (!response.ok) {
            throw new Error(`Slack webhook failed (${response.status})`);
        }
        return {};
    }
}
