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
                args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
                executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined
            }
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
        if (message.interactive) {
            // No native buttons on whatsapp-web; a native Poll is the selector.
            const poll = new Poll(
                message.interactive.text,
                message.interactive.options.map((option) => option.label)
            );
            const sent = await this.client.sendMessage(message.peerId, poll);
            return { externalId: sent.id?._serialized };
        }
        const sent = await this.client.sendMessage(message.peerId, message.text ?? "");
        return { externalId: sent.id?._serialized };
    }
}
