/**
 * Telegram adapter over the Bot API - no browser, native inline-keyboard buttons
 * and polls, free. Sends text, inline-keyboard prompts, or polls. Nothing reads
 * replies, so it holds no connection: connect only checks the token (getMe).
 */

import { capabilitiesFor } from "@polaris/messaging";
import type { ChannelAdapter, OutboundMessage, SendResult } from "@polaris/messaging";

const API_BASE = "https://api.telegram.org";

interface TelegramUser {
    first_name?: string;
    username?: string;
}

export class TelegramAdapter implements ChannelAdapter {
    readonly capabilities = capabilitiesFor("telegram");
    private readonly token: string;

    constructor(token: string) {
        this.token = token;
    }

    private async call<T>(method: string, body?: unknown): Promise<T> {
        const response = await fetch(`${API_BASE}/bot${this.token}/${method}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body)
        });
        const data = (await response.json()) as { ok: boolean; result?: T; description?: string };
        if (!data.ok) throw new Error(data.description ?? `Telegram ${method} failed`);
        return data.result as T;
    }

    async connect(): Promise<{ externalId?: string }> {
        const me = await this.call<TelegramUser>("getMe");
        return { externalId: me.username };
    }

    async disconnect(): Promise<void> {}

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
