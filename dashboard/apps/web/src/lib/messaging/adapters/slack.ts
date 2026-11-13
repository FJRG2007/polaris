/**
 * Slack adapter over the Web API. Sends text or Block Kit buttons; validates the
 * bot token on connect (auth.test) and returns the workspace id so the web webhook
 * can map inbound events to this channel. Inbound arrives on the web's Slack Events
 * webhook, not here, so there is no persistent connection.
 */

import { capabilitiesFor } from "@polaris/messaging";
import type { AdapterContext, ChannelAdapter, OutboundMessage, SendResult } from "@polaris/messaging";

const SLACK_API = "https://slack.com/api";

export class SlackAdapter implements ChannelAdapter {
    readonly capabilities = capabilitiesFor("slack");
    private readonly token: string;
    private readonly ctx: AdapterContext;

    constructor(token: string, ctx: AdapterContext) {
        this.token = token;
        this.ctx = ctx;
    }

    private async api<T>(method: string, body?: unknown): Promise<T> {
        const response = await fetch(`${SLACK_API}/${method}`, {
            method: "POST",
            headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json; charset=utf-8" },
            body: body === undefined ? undefined : JSON.stringify(body)
        });
        const data = (await response.json()) as { ok: boolean; error?: string } & T;
        if (!data.ok) throw new Error(data.error ?? `Slack ${method} failed`);
        return data;
    }

    async connect(): Promise<{ externalId?: string }> {
        const info = await this.api<{ team_id?: string; team?: string }>("auth.test");
        this.ctx.log("connected to Slack");
        return { externalId: info.team_id ?? info.team };
    }

    async disconnect(): Promise<void> {
        // Inbound arrives via the web webhook; nothing to tear down.
    }

    async send(message: OutboundMessage): Promise<SendResult> {
        const prompt = message.interactive;
        const blocks = prompt
            ? [
                  { type: "section", text: { type: "mrkdwn", text: prompt.text } },
                  {
                      type: "actions",
                      elements: prompt.options.slice(0, 5).map((option) => ({
                          type: "button",
                          text: { type: "plain_text", text: option.label.slice(0, 75) },
                          value: option.id,
                          action_id: option.id
                      }))
                  }
              ]
            : undefined;
        const result = await this.api<{ ts?: string }>("chat.postMessage", {
            channel: message.peerId,
            text: message.text ?? prompt?.text ?? "",
            ...(blocks ? { blocks } : {})
        });
        return { externalId: result.ts };
    }
}
