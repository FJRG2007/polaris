/**
 * WhatsApp Web adapter (free, unofficial) via whatsapp-web.js + Puppeteer. Logs in
 * by QR (surfaced as a data-URL through getState), persists the session on disk
 * (LocalAuth on the sessions volume) so it survives restarts, and receives
 * messages live. WhatsApp removed interactive buttons for unofficial clients, so a
 * selector is sent as a native Poll. Heavier than the other adapters (one Chromium
 * per number) and carries a ban risk - offered as an option, not the default.
 *
 * whatsapp-web.js is CommonJS (`export =`); createRequire keeps the ESM bridge
 * happy and leaves it external so its node_modules (and Chromium) resolve at
 * runtime rather than being bundled.
 */

import { createRequire } from "node:module";
import QRCode from "qrcode";
import { capabilitiesFor } from "@polaris/messaging";
import type { AdapterContext, ChannelAdapter, ChannelState, OutboundMessage, SendResult } from "@polaris/messaging";

const requireCjs = createRequire(import.meta.url);
const WAWebJS = requireCjs("whatsapp-web.js") as typeof import("whatsapp-web.js");
const { Client, LocalAuth, Poll } = WAWebJS;

const SESSION_DIR = process.env.WA_SESSION_DIR ?? "/app/.sessions";

export class WhatsAppWebAdapter implements ChannelAdapter {
    readonly capabilities = capabilitiesFor("whatsapp", "whatsapp-web");
    private readonly channelId: string;
    private readonly ctx: AdapterContext;
    private readonly client: InstanceType<typeof Client>;
    private state: ChannelState = { status: "connecting" };

    constructor(channelId: string, ctx: AdapterContext) {
        this.channelId = channelId;
        this.ctx = ctx;
        this.client = new Client({
            authStrategy: new LocalAuth({ clientId: channelId, dataPath: SESSION_DIR }),
            puppeteer: {
                headless: true,
                args: [
                    "--no-sandbox",
                    "--disable-setuid-sandbox",
                    "--disable-dev-shm-usage",
                    // Drop the automation fingerprint. This removes navigator.webdriver
                    // (the main "this is a bot" signal WhatsApp Web checks for) and the
                    // "controlled by automated software" infobar, so a normal linked
                    // device is not flagged as scripted. No stealth-plugin dependency.
                    "--disable-blink-features=AutomationControlled",
                    "--disable-infobars"
                ],
                executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined
            },
            // Stop regenerating the QR forever when it is never scanned, so an idle
            // onboarding does not keep re-requesting a device link.
            qrMaxRetries: 3
        });
        this.wire();
    }

    private wire(): void {
        this.client.on("qr", (qr: string) => {
            void QRCode.toDataURL(qr)
                .then((dataUrl) => {
                    this.state = { status: "qr", qr: dataUrl };
                })
                .catch(() => undefined);
        });
        this.client.on("ready", () => {
            this.state = { status: "connected", externalId: this.client.info?.wid?.user };
            this.ctx.log("whatsapp-web ready");
        });
        this.client.on("auth_failure", (message: string) => {
            this.state = { status: "error", detail: message };
        });
        this.client.on("disconnected", (reason: string) => {
            this.state = { status: "disconnected", detail: String(reason) };
        });
        this.client.on("message", (message: import("whatsapp-web.js").Message) => {
            if (message.fromMe) return;
            this.ctx.onInbound({
                channelId: this.channelId,
                peerId: message.from,
                externalId: message.id?._serialized,
                kind: "text",
                body: message.body,
                at: Date.now()
            });
        });
    }

    async connect(): Promise<{ externalId?: string }> {
        void this.client.initialize().catch((error: unknown) => {
            this.state = { status: "error", detail: error instanceof Error ? error.message : "initialization failed" };
        });
        return {};
    }

    async disconnect(): Promise<void> {
        try {
            await this.client.destroy();
        } catch {
            // Already torn down.
        }
    }

    getState(): ChannelState {
        return this.state;
    }

    async send(message: OutboundMessage): Promise<SendResult> {
        const chatId = await this.resolveChatId(message.peerId);
        if (message.interactive) {
            // No native buttons on whatsapp-web; a native Poll is the selector.
            const poll = new Poll(
                message.interactive.text,
                message.interactive.options.map((option) => option.label)
            );
            return { externalId: await this.deliver(chatId, poll) };
        }
        return { externalId: await this.deliver(chatId, message.text ?? "") };
    }

    /** Resolve the recipient to a canonical chat id. A group or already-serialized
     *  id passes through; a phone number is validated via getNumberId so the send
     *  targets a real WhatsApp user and whatsapp-web.js can build its result model
     *  (sending to an unresolved number is what triggers the post-send crash). */
    private async resolveChatId(peerId: string): Promise<string> {
        if (peerId.endsWith("@g.us")) return peerId;
        const digits = peerId.replace(/\D/g, "");
        if (!digits) return peerId;
        const numberId = await this.client.getNumberId(digits);
        if (!numberId) throw new Error("That number is not on WhatsApp");
        return numberId._serialized;
    }

    /** Send and return the platform message id. whatsapp-web.js delivers the
     *  message but can still throw while building its return Message model for a
     *  fresh chat ("Cannot read properties of undefined (reading 'id')"); that
     *  specific post-send error is not a delivery failure, so swallow it and report
     *  the message as sent (without an id) rather than marking it failed. */
    private async deliver(chatId: string, content: string | InstanceType<typeof Poll>): Promise<string | undefined> {
        try {
            const sent = await this.client.sendMessage(chatId, content);
            return sent?.id?._serialized;
        } catch (caught) {
            const detail = caught instanceof Error ? caught.message : String(caught);
            if (/reading '?(_serialized|id)'?|getMessageModel|serialize/i.test(detail)) return undefined;
            throw caught;
        }
    }
}
