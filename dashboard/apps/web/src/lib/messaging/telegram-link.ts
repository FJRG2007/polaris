/**
 * Linking a person's Telegram account for verification codes.
 *
 * The bot is the deployment's Telegram code sender (Integrations > Messaging).
 * Starting a link stores the hash of a one-time token and hands back the deep
 * link; checking reads the bot's pending updates (`getUpdates`) for the
 * `/start <token>` that pressing Start sends, and binds that private chat.
 * `getUpdates` is refused while a webhook is set on the bot, which Polaris never
 * does; a bot shared with something that set one says so instead of linking.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import { codeRouteFor } from "./code-senders";
import { NO_CODE_SENDER } from "./code-route";
import { connectRequestFor } from "./channel-runtime";
import {
    findStartChat,
    hashLinkToken,
    LINK_TTL_MS,
    newLinkToken,
    telegramStartLink,
    type StartUpdate
} from "./telegram-link-token";

const API_BASE = "https://api.telegram.org";
const TIMEOUT_MS = 10_000;

export interface TelegramLinkView {
    linked: boolean;
    username: string | null;
}

/** What the settings row shows. */
export async function getTelegramLink(userId: string): Promise<TelegramLinkView> {
    const row = await prisma.userTelegram.findUnique({
        where: { userId },
        select: { chatId: true, verifiedAt: true, username: true }
    });
    return { linked: Boolean(row?.chatId && row.verifiedAt), username: row?.username ?? null };
}

/** The verified chat a code goes to, or null. */
export async function telegramChatFor(userId: string): Promise<string | null> {
    const row = await prisma.userTelegram.findUnique({
        where: { userId },
        select: { chatId: true, verifiedAt: true }
    });
    return row?.chatId && row.verifiedAt ? row.chatId : null;
}

/** The bot that carries this person's codes, with its token. */
async function botFor(userId: string): Promise<{ token: string; username: string } | { error: string }> {
    const route = await codeRouteFor("telegram", userId);
    if (route.channelId === null) return { error: route.blocker };
    const channel = await prisma.channel.findUnique({ where: { id: route.channelId } });
    const token = channel ? connectRequestFor(channel).token : undefined;
    if (!channel || !token || !channel.externalId) return { error: NO_CODE_SENDER.telegram };
    return { token, username: channel.externalId };
}

/** Mint a fresh link, replacing any earlier one. */
export async function startTelegramLink(userId: string): Promise<{ url?: string; error?: string }> {
    const bot = await botFor(userId);
    if ("error" in bot) return { error: bot.error };
    const token = newLinkToken();
    const data = { linkTokenHash: hashLinkToken(token), linkExpiresAt: new Date(Date.now() + LINK_TTL_MS) };
    await prisma.userTelegram.upsert({ where: { userId }, create: { userId, ...data }, update: data });
    return { url: telegramStartLink(bot.username, token) };
}

/**
 * Look for the Start press. The token itself is not kept, so the check walks the
 * updates and compares each `/start` payload by hash.
 */
export async function checkTelegramLink(userId: string): Promise<{ linked: boolean; error?: string }> {
    const row = await prisma.userTelegram.findUnique({
        where: { userId },
        select: { linkTokenHash: true, linkExpiresAt: true }
    });
    if (!row?.linkTokenHash || !row.linkExpiresAt || row.linkExpiresAt.getTime() < Date.now()) {
        return { linked: false, error: "That link has expired. Start again." };
    }
    const bot = await botFor(userId);
    if ("error" in bot) return { linked: false, error: bot.error };

    let updates: StartUpdate[];
    try {
        const response = await fetch(`${API_BASE}/bot${bot.token}/getUpdates`, {
            method: "POST",
            cache: "no-store",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ allowed_updates: ["message"], timeout: 0 }),
            signal: AbortSignal.timeout(TIMEOUT_MS)
        });
        const data = (await response.json()) as { ok: boolean; result?: StartUpdate[]; description?: string };
        if (!data.ok) return { linked: false, error: data.description ?? "Telegram did not answer." };
        updates = data.result ?? [];
    } catch {
        return { linked: false, error: "Telegram could not be reached." };
    }

    const starts = updates
        .map((update) => update.message?.text?.trim() ?? "")
        .filter((text) => text.startsWith("/start "))
        .map((text) => text.slice("/start ".length));
    const token = starts.find((candidate) => hashLinkToken(candidate) === row.linkTokenHash);
    const found = token ? findStartChat(updates, token) : null;
    if (!found) return { linked: false };

    await prisma.userTelegram.update({
        where: { userId },
        data: {
            chatId: found.chatId,
            username: found.username,
            verifiedAt: new Date(),
            linkTokenHash: null,
            linkExpiresAt: null
        }
    });
    return { linked: true };
}

/** Forget the linked chat. */
export async function unlinkTelegram(userId: string): Promise<void> {
    await prisma.userTelegram.deleteMany({ where: { userId } });
}
