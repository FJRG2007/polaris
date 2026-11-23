/**
 * The deployment's code senders: which messaging channel carries WhatsApp and
 * Telegram verification codes. Stored as settings, like the account mail
 * channel, so nothing in `.env` is needed and an unset choice is simply "none".
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import { getSettings, setSetting } from "@/lib/setting-store";
import { resolveCodeRoute, type CodePlatform, type CodeRoute } from "./code-route";

const SETTING_KEYS: Record<CodePlatform, string> = {
    whatsapp: "messaging.codeSender.whatsapp",
    telegram: "messaging.codeSender.telegram"
};

export const CODE_PLATFORMS: readonly CodePlatform[] = ["whatsapp", "telegram"];

/** The picked channel id per platform (null when none is picked). */
export async function getCodeSenders(): Promise<Record<CodePlatform, string | null>> {
    const stored = await getSettings(Object.values(SETTING_KEYS));
    return {
        whatsapp: stored.get(SETTING_KEYS.whatsapp) ?? null,
        telegram: stored.get(SETTING_KEYS.telegram) ?? null
    };
}

/** Pick (or clear) the channel that carries one platform's codes. */
export async function setCodeSender(platform: CodePlatform, channelId: string | null): Promise<{ error?: string }> {
    if (channelId === null) {
        await setSetting(SETTING_KEYS[platform], null);
        return {};
    }
    const channel = await prisma.channel.findFirst({
        where: { id: channelId, platform },
        select: { id: true }
    });
    if (!channel) return { error: "That channel is not a connected one for this platform." };
    await setSetting(SETTING_KEYS[platform], channel.id);
    return {};
}

/** The channel a code for this person goes through on one platform, or why none can. */
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
        prisma.channel.findFirst({
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
