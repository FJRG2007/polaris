/**
 * The deployment's code senders: which messaging channel carries WhatsApp and
 * Telegram verification codes, and which SMS sender carries text-message codes. Stored as settings, like the account mail
 * channel, so nothing in `.env` is needed and an unset choice is simply "none".
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import { SMS_PLATFORM } from "@polaris/core";
import { getSettings, setSetting } from "@/lib/setting-store";
import { resolveCodeRoute, type CodePlatform, type CodeRoute } from "./code-route";

const SETTING_KEYS: Record<CodePlatform, string> = {
    whatsapp: "messaging.codeSender.whatsapp",
    telegram: "messaging.codeSender.telegram",
    sms: "messaging.codeSender.sms"
};

export const CODE_PLATFORMS: readonly CodePlatform[] = ["whatsapp", "telegram", "sms"];

/** The picked channel id per platform (null when none is picked). */
export async function getCodeSenders(): Promise<Record<CodePlatform, string | null>> {
    const stored = await getSettings(Object.values(SETTING_KEYS));
    return {
        whatsapp: stored.get(SETTING_KEYS.whatsapp) ?? null,
        telegram: stored.get(SETTING_KEYS.telegram) ?? null,
        sms: stored.get(SETTING_KEYS.sms) ?? null
    };
}

/**
 * Pick (or clear) the channel that carries one platform's codes. An SMS sender
 * has to be a connected one an administrator added: SMS senders live beside the
 * personal notification senders in the same table, and one of those must never
 * start carrying every account's codes.
 */
export async function setCodeSender(platform: CodePlatform, channelId: string | null): Promise<{ error?: string }> {
    if (channelId === null) {
        await setSetting(SETTING_KEYS[platform], null);
        return {};
    }
    const channel = await prisma.channel.findFirst({
        where:
            platform === "sms"
                ? { id: channelId, platform: SMS_PLATFORM, status: "connected" }
                : { id: channelId, platform },
        select: { id: true, ownerId: true }
    });
    if (!channel) return { error: "That channel is not a connected one for this platform." };
    if (platform === "sms") {
        const owner = await prisma.user.findUnique({ where: { id: channel.ownerId }, select: { isAdmin: true } });
        if (!owner?.isAdmin) return { error: "That channel is not a connected one for this platform." };
    }
    await setSetting(SETTING_KEYS[platform], channel.id);
    return {};
}

/**
 * The channel a code for this person goes through on one platform, or why none
 * can. SMS has no "own channel" fallback: a personal SMS sender exists for that
 * person's alerts, and SMS codes are only on when an administrator turned them on.
 */
export async function codeRouteFor(platform: CodePlatform, userId: string): Promise<CodeRoute> {
    const senders = await getCodeSenders();
    const senderId = senders[platform];
    const [adminSender, ownChannel] = await Promise.all([
        senderId
            ? prisma.channel.findUnique({
                  where: { id: senderId },
                  select: { id: true, platform: true, status: true }
              })
            : Promise.resolve(null),
        platform === "sms"
            ? Promise.resolve(null)
            : prisma.channel.findFirst({
                  where: { ownerId: userId, platform, status: "connected" },
                  orderBy: { createdAt: "asc" },
                  select: { id: true }
              })
    ]);
    return resolveCodeRoute(platform, { adminSender, ownChannel });
}

/**
 * Whether the deployment itself can carry a code on this platform to anybody: an
 * administrator picked a sender and it is still connected. A person's own channel
 * does not count, because it only reaches that one person.
 */
export async function codeSenderReady(platform: CodePlatform): Promise<boolean> {
    const senderId = (await getCodeSenders())[platform];
    if (!senderId) return false;
    const adminSender = await prisma.channel.findUnique({
        where: { id: senderId },
        select: { id: true, platform: true, status: true }
    });
    return resolveCodeRoute(platform, { adminSender, ownChannel: null }).channelId !== null;
}

/** An SMS sender an administrator added, as the code-sender switch lists it. */
export interface SmsCodeSenderOption {
    id: string;
    name: string;
    connected: boolean;
}

/** How many SMS senders the switch lists - a handful in practice. */
const SMS_SENDER_LIMIT = 50;

/**
 * The SMS senders that may carry codes: the ones administrators added under
 * Integrations > Email & SMS. A sender a person added for their own alerts is
 * not listed and cannot be picked (setCodeSender).
 */
export async function listSmsCodeSenders(): Promise<SmsCodeSenderOption[]> {
    const admins = await prisma.user.findMany({ where: { isAdmin: true }, select: { id: true }, take: 200 });
    if (admins.length === 0) return [];
    const rows = await prisma.channel.findMany({
        where: { platform: SMS_PLATFORM, ownerId: { in: admins.map((admin) => admin.id) } },
        orderBy: { createdAt: "asc" },
        take: SMS_SENDER_LIMIT,
        select: { id: true, name: true, status: true }
    });
    return rows.map((row) => ({ id: row.id, name: row.name, connected: row.status === "connected" }));
}

/**
 * How a code confirming a phone number reaches it: WhatsApp first, as it always
 * has, then the SMS sender when an administrator turned SMS codes on - so a
 * deployment with SMS and no WhatsApp can still confirm the numbers its SMS codes
 * go to. Null when neither can.
 */
export async function phoneCodeRoute(
    userId: string
): Promise<{ platform: "whatsapp" | "sms"; channelId: string } | null> {
    const [whatsapp, sms] = await Promise.all([codeRouteFor("whatsapp", userId), codeRouteFor("sms", userId)]);
    if (whatsapp.channelId !== null) return { platform: "whatsapp", channelId: whatsapp.channelId };
    if (sms.channelId !== null) return { platform: "sms", channelId: sms.channelId };
    return null;
}

/** Whether the deployment itself can confirm anybody's phone number (WhatsApp or SMS). */
export async function phoneSenderReady(): Promise<boolean> {
    const [whatsapp, sms] = await Promise.all([codeSenderReady("whatsapp"), codeSenderReady("sms")]);
    return whatsapp || sms;
}
