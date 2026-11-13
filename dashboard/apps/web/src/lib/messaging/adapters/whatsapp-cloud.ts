/**
 * WhatsApp Cloud API adapter (official Meta). No browser: it authenticates with a
 * permanent access token + phone-number id, sends text and native interactive
 * messages (reply buttons for up to 3 options, a list beyond that), and returns
 * the platform message id. Inbound arrives via the web's Meta webhook, not here,
 * so this adapter only validates on connect and sends.
 */

import { capabilitiesFor } from "@polaris/messaging";
import type { AdapterContext, ChannelAdapter, InteractivePrompt, OutboundMessage, SendResult } from "@polaris/messaging";

const GRAPH_BASE = "https://graph.facebook.com/v21.0";

export class WhatsAppCloudAdapter implements ChannelAdapter {
    readonly capabilities = capabilitiesFor("whatsapp", "whatsapp-cloud");
    private readonly token: string;
    private readonly phoneNumberId: string;
    private readonly ctx: AdapterContext;

    constructor(token: string, phoneNumberId: string, ctx: AdapterContext) {
        this.token = token;
        this.phoneNumberId = phoneNumberId;
        this.ctx = ctx;
    }

    private async graph<T>(path: string, body?: unknown): Promise<T> {
        const response = await fetch(`${GRAPH_BASE}/${path}`, {
            method: body === undefined ? "GET" : "POST",
            headers: {
                authorization: `Bearer ${this.token}`,
                ...(body === undefined ? {} : { "content-type": "application/json" })
            },
            body: body === undefined ? undefined : JSON.stringify(body)
        });
        const data = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
        if (!response.ok) throw new Error(data.error?.message ?? `WhatsApp Cloud request to ${path} failed`);
        return data as T;
    }

    async connect(): Promise<{ externalId?: string }> {
        const info = await this.graph<{ display_phone_number?: string }>(
            `${this.phoneNumberId}?fields=display_phone_number`
        );
        this.ctx.log("connected to WhatsApp Cloud");
        return { externalId: info.display_phone_number };
    }

    async disconnect(): Promise<void> {
        // Inbound arrives via the web webhook; there is nothing to tear down.
    }

    private interactivePayload(to: string, prompt: InteractivePrompt): unknown {
        // Up to 3 options render as reply buttons; more become a single-section list
        // (WhatsApp caps buttons at 3 and list rows at 10; titles are length-capped).
        if (prompt.options.length <= 3) {
            return {
                messaging_product: "whatsapp",
                to,
                type: "interactive",
                interactive: {
                    type: "button",
                    body: { text: prompt.text },
                    action: {
                        buttons: prompt.options.map((option) => ({
                            type: "reply",
                            reply: { id: option.id, title: option.label.slice(0, 20) }
                        }))
                    }
                }
            };
        }
        return {
            messaging_product: "whatsapp",
            to,
            type: "interactive",
            interactive: {
                type: "list",
                body: { text: prompt.text },
                action: {
                    button: "Choose",
                    sections: [
                        {
                            rows: prompt.options.slice(0, 10).map((option) => ({
                                id: option.id,
                                title: option.label.slice(0, 24)
                            }))
                        }
                    ]
                }
            }
        };
    }

    async send(message: OutboundMessage): Promise<SendResult> {
        const to = message.peerId;
        const payload = message.interactive
            ? this.interactivePayload(to, message.interactive)
            : { messaging_product: "whatsapp", to, type: "text", text: { body: message.text ?? "" } };
        const result = await this.graph<{ messages?: { id?: string }[] }>(`${this.phoneNumberId}/messages`, payload);
        return { externalId: result.messages?.[0]?.id };
    }
}
