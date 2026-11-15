/**
 * WhatsApp through Twilio's WhatsApp Business API sender. Send-only: one form POST
 * to the Messages resource, authenticated with the account SID and auth token
 * (the same call the SMS sender makes). Codes go through an approved Content
 * Template; plain text only reaches someone who wrote within the last 24 hours.
 */

import { capabilitiesFor } from "@polaris/messaging";
import { twilioAddress, twilioCodeForm } from "../whatsapp-template";
import type { AdapterContext, ChannelAdapter, OutboundMessage, SendResult } from "@polaris/messaging";

const API_BASE = "https://api.twilio.com/2010-04-01/Accounts";
const TIMEOUT_MS = 15_000;

export class WhatsAppTwilioAdapter implements ChannelAdapter {
    readonly capabilities = capabilitiesFor("whatsapp", "whatsapp-twilio");

    constructor(
        private readonly accountSid: string,
        private readonly authToken: string,
        private readonly from: string,
        private readonly contentSid: string | undefined,
        private readonly ctx: AdapterContext
    ) {}

    private authorization(): string {
        return `Basic ${Buffer.from(`${this.accountSid}:${this.authToken}`).toString("base64")}`;
    }

    private async post(form: URLSearchParams): Promise<SendResult> {
        const response = await fetch(`${API_BASE}/${encodeURIComponent(this.accountSid)}/Messages.json`, {
            method: "POST",
            cache: "no-store",
            headers: {
                authorization: this.authorization(),
                "content-type": "application/x-www-form-urlencoded"
            },
            body: form,
            signal: AbortSignal.timeout(TIMEOUT_MS)
        });
        const data = (await response.json().catch(() => ({}))) as { sid?: string; message?: string };
        if (!response.ok) throw new Error(data.message ?? `Twilio refused the message (HTTP ${response.status}).`);
        return { externalId: data.sid };
    }

    async connect(): Promise<{ externalId?: string }> {
        const response = await fetch(`${API_BASE}/${encodeURIComponent(this.accountSid)}.json`, {
            cache: "no-store",
            headers: { authorization: this.authorization() },
            signal: AbortSignal.timeout(TIMEOUT_MS)
        });
        if (response.status === 401) throw new Error("Twilio rejected that account SID and auth token.");
        if (!response.ok) throw new Error(`Twilio answered HTTP ${response.status}.`);
        this.ctx.log("connected to Twilio");
        return { externalId: twilioAddress(this.from).slice("whatsapp:".length) };
    }

    async disconnect(): Promise<void> {}

    async send(message: OutboundMessage): Promise<SendResult> {
        return this.post(
            new URLSearchParams({
                From: twilioAddress(this.from),
                To: twilioAddress(message.peerId),
                Body: message.text ?? ""
            })
        );
    }

    async sendCode(message: { peerId: string; code: string; text: string }): Promise<SendResult> {
        if (!this.contentSid) return this.send({ peerId: message.peerId, text: message.text });
        return this.post(
            twilioCodeForm({ from: this.from, to: message.peerId, contentSid: this.contentSid, code: message.code })
        );
    }
}
