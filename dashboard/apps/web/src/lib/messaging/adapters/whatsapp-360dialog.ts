/**
 * WhatsApp through 360dialog, a Meta Business Solution Provider whose API takes
 * the Cloud API's own message bodies at `https://waba-v2.360dialog.io/messages`,
 * authenticated with a `D360-API-KEY` header (docs.360dialog.com). Send-only.
 */

import { capabilitiesFor } from "@polaris/messaging";
import type { AdapterContext, ChannelAdapter, OutboundMessage, SendResult } from "@polaris/messaging";
import {
    authenticationTemplatePayload,
    cloudTextPayload,
    whatsappDigits,
    type CodeTemplate
} from "../whatsapp-template";

const API_URL = "https://waba-v2.360dialog.io/messages";
const TIMEOUT_MS = 15_000;

export class WhatsApp360DialogAdapter implements ChannelAdapter {
    readonly capabilities = capabilitiesFor("whatsapp", "whatsapp-360dialog");

    constructor(
        private readonly apiKey: string,
        private readonly number: string | undefined,
        private readonly template: CodeTemplate | null,
        private readonly ctx: AdapterContext
    ) {}

    private async post(body: unknown): Promise<SendResult> {
        const response = await fetch(API_URL, {
            method: "POST",
            cache: "no-store",
            headers: { "D360-API-KEY": this.apiKey, "content-type": "application/json" },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(TIMEOUT_MS)
        });
        const data = (await response.json().catch(() => ({}))) as {
            messages?: { id?: string }[];
            error?: { message?: string };
        };
        if (!response.ok) {
            throw new Error(data.error?.message ?? `360dialog refused the message (HTTP ${response.status}).`);
        }
        return { externalId: data.messages?.[0]?.id };
    }

    async connect(): Promise<{ externalId?: string }> {
        // 360dialog documents no read-only call to check a key with; the first send does.
        this.ctx.log("360dialog channel ready");
        return { externalId: this.number ? `+${whatsappDigits(this.number)}` : "360dialog" };
    }

    async disconnect(): Promise<void> {}

    async send(message: OutboundMessage): Promise<SendResult> {
        return this.post(cloudTextPayload(message.peerId, message.text ?? ""));
    }

    async sendCode(message: { peerId: string; code: string; text: string }): Promise<SendResult> {
        if (!this.template) return this.send({ peerId: message.peerId, text: message.text });
        return this.post(
            authenticationTemplatePayload({ to: message.peerId, template: this.template, code: message.code })
        );
    }
}
