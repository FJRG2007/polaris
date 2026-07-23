/**
 * Telegram adapter over the Bot API - no browser, native inline-keyboard buttons
 * and polls, free. Receives with long-polled getUpdates and normalizes each
 * update into an InboundMessage; sends text, inline-keyboard prompts, or polls.
 */

import { capabilitiesFor } from "@polaris/messaging";
import type { AdapterContext, ChannelAdapter, OutboundMessage, SendResult } from "@polaris/messaging";

const API_BASE = "https://api.telegram.org";

interface TelegramUser {
    first_name?: string;
    username?: string;
}

interface TelegramUpdate {
    update_id: number;
    message?: {
        message_id: number;
        from?: TelegramUser;
        chat: { id: number };
        text?: string;
    };
    callback_query?: {
        id: string;
        from?: TelegramUser;
        message?: { chat: { id: number } };
        data?: string;
    };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class TelegramAdapter implements ChannelAdapter {
    readonly capabilities = capabilitiesFor("telegram");
    private readonly token: string;
    private readonly ctx: AdapterContext;
    private offset = 0;
    private running = false;
    private poller?: AbortController;

    constructor(token: string, ctx: AdapterContext) {
        this.token = token;
        this.ctx = ctx;
    }

    private async call<T>(method: string, body?: unknown, signal?: AbortSignal): Promise<T> {
        const response = await fetch(`${API_BASE}/bot${this.token}/${method}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal
        });
        const data = (await response.json()) as { ok: boolean; result?: T; description?: string };
        if (!data.ok) throw new Error(data.description ?? `Telegram ${method} failed`);
        return data.result as T;
    }

    async connect(): Promise<{ externalId?: string }> {
        const me = await this.call<TelegramUser>("getMe");
        this.running = true;
        void this.pollLoop();
        return { externalId: me.username };
    }

    async disconnect(): Promise<void> {
        this.running = false;
        this.poller?.abort();
    }

    private async pollLoop(): Promise<void> {
        while (this.running) {
            this.poller = new AbortController();
            try {
                const updates = await this.call<TelegramUpdate[]>(
                    "getUpdates",
                    { offset: this.offset, timeout: 30 },
                    this.poller.signal
                );
                for (const update of updates) {
                    this.offset = update.update_id + 1;
                    this.handle(update);
                }
            } catch (caught) {
                if (!this.running) return;
                this.ctx.log(`poll error: ${caught instanceof Error ? caught.message : String(caught)}`);
                await sleep(2000);
            }
        }
    }

    private handle(update: TelegramUpdate): void {
        const message = update.message;
        if (message?.text) {
            this.ctx.onInbound({
                channelId: this.ctx.channelId,
                peerId: String(message.chat.id),
                peerName: message.from?.username ?? message.from?.first_name,
                externalId: String(message.message_id),
                kind: "text",
                body: message.text,
                at: Date.now()
            });
            return;
        }
        const callback = update.callback_query;
        if (callback?.data && callback.message) {
            // Acknowledge so Telegram stops the loading spinner on the button.
            void this.call("answerCallbackQuery", { callback_query_id: callback.id }).catch(() => undefined);
            this.ctx.onInbound({
                channelId: this.ctx.channelId,
                peerId: String(callback.message.chat.id),
                peerName: callback.from?.username ?? callback.from?.first_name,
                kind: "interactive",
                selection: callback.data,
                at: Date.now()
            });
        }
    }

    async send(message: OutboundMessage): Promise<SendResult> {
        const chatId = message.peerId;
        const prompt = message.interactive;
        if (prompt) {
            if (prompt.style === "poll") {
                const poll = await this.call<{ message_id: number }>("sendPoll", {
                    chat_id: chatId,
                    question: prompt.text,
                    options: prompt.options.map((option) => option.label)
                });
                return { externalId: String(poll.message_id) };
            }
            const sent = await this.call<{ message_id: number }>("sendMessage", {
                chat_id: chatId,
                text: prompt.text,
                reply_markup: {
                    inline_keyboard: prompt.options.map((option) => [{ text: option.label, callback_data: option.id }])
                }
            });
            return { externalId: String(sent.message_id) };
        }
        const sent = await this.call<{ message_id: number }>("sendMessage", {
            chat_id: chatId,
            text: message.text ?? ""
        });
        return { externalId: String(sent.message_id) };
    }
}
