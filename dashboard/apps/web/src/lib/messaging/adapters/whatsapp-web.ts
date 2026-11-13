/**
 * WhatsApp Web adapter (free, unofficial): a linked device spoken to over
 * WhatsApp's own WebSocket protocol through Baileys - no browser. Logs in by QR
 * (surfaced as a data-URL through getState), keeps the linked device's keys on
 * disk under the data directory so it survives restarts and updates, and
 * receives messages live. WhatsApp removed interactive buttons for unofficial
 * clients, so a selector is sent as a native poll. Carries a ban risk - offered
 * as an option, not the default.
 *
 * It used to drive a whole Chromium per number (whatsapp-web.js + Puppeteer),
 * which is hundreds of megabytes of image and memory for one text; a socket is a
 * few. The channel runtime imports this module only once a whatsapp-web channel
 * exists.
 */

import QRCode from "qrcode";
import {
    DisconnectReason,
    makeWASocket,
    // Renamed: it is not a React hook, whatever its name says.
    useMultiFileAuthState as loadDeviceKeys,
    type WASocket
} from "@whiskeysockets/baileys";
import { rm } from "node:fs/promises";
import { whatsappAuthDir } from "../whatsapp-session";
import { capabilitiesFor } from "@polaris/messaging";
import type {
    AdapterContext,
    ChannelAdapter,
    ChannelState,
    OutboundMessage,
    SendResult
} from "@polaris/messaging";

/** QR codes shown before an unscanned link is given up, so an onboarding left
 *  open does not keep asking WhatsApp for a device link forever. */
const QR_LIMIT = 5;

/** Baileys' logger shape, which its index does not export by name. */
type ILogger = NonNullable<Parameters<typeof makeWASocket>[0]["logger"]>;

/** How long after a dropped connection the socket is opened again. */
const RECONNECT_MS = 3_000;

/** Baileys logs every frame; Polaris keeps only what the channel reports. */
function silentLogger(): ILogger {
    const logger: ILogger = {
        level: "silent",
        child: () => logger,
        trace: () => undefined,
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined
    };
    return logger;
}

/** The text of an incoming message, from the shapes a plain text arrives in. */
export function textOf(message: {
    conversation?: string | null;
    extendedTextMessage?: { text?: string | null } | null;
} | null | undefined): string {
    return message?.conversation ?? message?.extendedTextMessage?.text ?? "";
}

/** A recipient as WhatsApp addresses it: a group or user id as given, a phone
 *  number reduced to its digits. Null for nothing usable. */
export function recipientOf(peerId: string): { jid: string } | { digits: string } | null {
    if (peerId.includes("@")) return { jid: peerId };
    const digits = peerId.replace(/\D/g, "");
    return digits ? { digits } : null;
}

export class WhatsAppWebAdapter implements ChannelAdapter {
    readonly capabilities = capabilitiesFor("whatsapp", "whatsapp-web");
    private readonly channelId: string;
    private readonly ctx: AdapterContext;
    private socket: WASocket | null = null;
    private state: ChannelState = { status: "connecting" };
    private stopped = false;
    private qrShown = 0;
    private retry: ReturnType<typeof setTimeout> | null = null;

    constructor(channelId: string, ctx: AdapterContext) {
        this.channelId = channelId;
        this.ctx = ctx;
    }

    async connect(): Promise<{ externalId?: string }> {
        this.stopped = false;
        this.qrShown = 0;
        void this.open().catch((error: unknown) => {
            this.state = {
                status: "error",
                detail: error instanceof Error ? error.message : "initialization failed"
            };
        });
        return {};
    }

    private async open(): Promise<void> {
        if (this.stopped) return;
        const { state, saveCreds } = await loadDeviceKeys(whatsappAuthDir(this.channelId));
        // Disconnected while the keys were being read: no socket to open.
        if (this.stopped) return;
        const socket = makeWASocket({ auth: state, logger: silentLogger(), markOnlineOnConnect: false });
        this.socket = socket;
        socket.ev.on("creds.update", () => void saveCreds());
        socket.ev.on("connection.update", (update) => {
            if (update.qr) {
                this.qrShown += 1;
                if (this.qrShown > QR_LIMIT) {
                    this.stopped = true;
                    this.state = {
                        status: "disconnected",
                        detail: "The QR code expired before it was scanned. Connect again for a new one."
                    };
                    socket.end(undefined);
                    return;
                }
                void QRCode.toDataURL(update.qr)
                    .then((dataUrl) => {
                        if (!this.stopped) this.state = { status: "qr", qr: dataUrl };
                    })
                    .catch(() => undefined);
            }
            if (update.connection === "open") {
                this.qrShown = 0;
                const user = socket.user?.id?.split(":")[0]?.split("@")[0];
                this.state = { status: "connected", externalId: user };
                this.ctx.log("whatsapp-web ready");
            }
            if (update.connection === "close") {
                const code = (update.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)
                    ?.output?.statusCode;
                if (code === DisconnectReason.loggedOut) {
                    // Unlinked from the phone: the keys are worthless now, and a
                    // new link starts from a clean folder.
                    this.stopped = true;
                    this.state = {
                        status: "disconnected",
                        detail: "This number was unlinked from WhatsApp. Connect again and scan the new QR code."
                    };
                    void rm(whatsappAuthDir(this.channelId), { recursive: true, force: true }).catch(
                        () => undefined
                    );
                    return;
                }
                if (this.stopped) return;
                // Any other close - the restart WhatsApp asks for right after a
                // link, a network drop - opens the socket again on the same keys.
                if (this.state.status === "connected") this.state = { status: "connecting" };
                this.retry = setTimeout(
                    () => void this.open().catch(() => undefined),
                    code === DisconnectReason.restartRequired ? 0 : RECONNECT_MS
                );
            }
        });
        socket.ev.on("messages.upsert", ({ messages, type }) => {
            if (type !== "notify") return;
            for (const message of messages) {
                if (message.key.fromMe || !message.key.remoteJid) continue;
                const body = textOf(message.message);
                if (!body) continue;
                this.ctx.onInbound({
                    channelId: this.channelId,
                    peerId: message.key.remoteJid,
                    externalId: message.key.id ?? undefined,
                    kind: "text",
                    body,
                    at: Date.now()
                });
            }
        });
    }

    async disconnect(): Promise<void> {
        this.stopped = true;
        if (this.retry) clearTimeout(this.retry);
        this.retry = null;
        try {
            this.socket?.end(undefined);
        } catch {
            // Already closed.
        }
        this.socket = null;
    }

    getState(): ChannelState {
        return this.state;
    }

    async send(message: OutboundMessage): Promise<SendResult> {
        const socket = this.socket;
        if (!socket || this.state.status !== "connected")
            throw new Error("WhatsApp Web is not linked right now. Connect it again and scan the QR code.");
        const jid = await this.resolveJid(socket, message.peerId);
        const sent = message.interactive
            ? await socket.sendMessage(jid, {
                  poll: {
                      name: message.interactive.text,
                      values: message.interactive.options.map((option) => option.label),
                      selectableCount: 1
                  }
              })
            : await socket.sendMessage(jid, { text: message.text ?? "" });
        return { externalId: sent?.key.id ?? undefined };
    }

    /** A phone number is checked against WhatsApp first, so a send never goes to
     *  a number that is not on it. */
    private async resolveJid(socket: WASocket, peerId: string): Promise<string> {
        const recipient = recipientOf(peerId);
        if (!recipient) throw new Error("That is not a WhatsApp number or chat");
        if ("jid" in recipient) return recipient.jid;
        const [found] = (await socket.onWhatsApp(recipient.digits)) ?? [];
        if (!found?.exists) throw new Error("That number is not on WhatsApp");
        return found.jid;
    }
}
