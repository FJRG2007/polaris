/**
 * The one-time token that binds a person's Telegram chat to their account.
 *
 * A bot cannot message somebody who never opened it, so linking has the person
 * open `https://t.me/<bot>?start=<token>`; Telegram then delivers `/start <token>`
 * from their chat, which is where the chat id comes from. Telegram allows
 * `A-Z a-z 0-9 _ -`, up to 64 characters, in that parameter and recommends
 * base64url (core.telegram.org/bots/features#deep-linking).
 *
 * Pure apart from the random bytes, so the flow can be asserted in a test.
 */

import { createHash, randomBytes } from "node:crypto";

/** How long a link stays good once shown. */
export const LINK_TTL_MS = 10 * 60 * 1000;

/** 24 random bytes as base64url: 32 characters, inside Telegram's 64. */
export function newLinkToken(): string {
    return randomBytes(24).toString("base64url");
}

/** What is stored: a token in the database is a link anyone reading it could press. */
export function hashLinkToken(token: string): string {
    return createHash("sha256").update(token).digest("hex");
}

/** The deep link the person opens. */
export function telegramStartLink(botUsername: string, token: string): string {
    return `https://t.me/${encodeURIComponent(botUsername.replace(/^@/, ""))}?start=${token}`;
}

/** The parts of a Bot API update this flow reads. */
export interface StartUpdate {
    update_id: number;
    message?: {
        text?: string;
        chat?: { id: number | string; type?: string; username?: string };
        from?: { username?: string; first_name?: string };
    };
}

/**
 * The private chat that sent `/start <token>`, if any did. A group start
 * (`/start@bot <token>`) is ignored: a code sent to a group is read by the group.
 */
export function findStartChat(
    updates: readonly StartUpdate[],
    token: string
): { chatId: string; username: string | null } | null {
    for (const update of updates) {
        const message = update.message;
        if (!message?.chat || message.text?.trim() !== `/start ${token}`) continue;
        if (message.chat.type && message.chat.type !== "private") continue;
        return {
            chatId: String(message.chat.id),
            username: message.chat.username ?? message.from?.username ?? message.from?.first_name ?? null
        };
    }
    return null;
}
