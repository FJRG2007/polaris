/**
 * Which email channel carries the mail the account system sends.
 *
 * One channel is nominated for all of it - verification links, password resets,
 * sign-in links and sign-in codes - because an operator reasoning about "can
 * Polaris email me" wants one answer, not four. Everything else about the
 * channel (its provider, its key, its From address) belongs to the channel.
 *
 * Nothing here throws when mail is unconfigured. A deployment with no email
 * channel is a perfectly ordinary Polaris: password sign-in works, and the
 * features that need mail report themselves unavailable rather than failing at
 * the moment a user is locked out and needs them.
 */

import { EMAIL_PLATFORM } from "@polaris/core";
import { prisma } from "@polaris/db";
import { getSetting, setSetting } from "./setting-store";
import { sendThroughChannel } from "./mail-service";
import type { EmailMessage } from "./mail/types";

const CHANNEL_KEY = "auth.mail.channel";

/** What the account system can do with mail on this deployment. */
export interface AuthMailStatus {
    /** The email channel that sends it, or null when none is nominated. */
    channelId: string | null;
    /** The channel is present and last reported itself working. */
    ready: boolean;
}

/**
 * The nominated channel. One that has since been deleted reads back as none, so
 * a stale id can never leave the mail-backed features looking available.
 */
export async function getAuthMailStatus(): Promise<AuthMailStatus> {
    const channelId = await getSetting(CHANNEL_KEY);
    const channel = channelId
        ? await prisma.channel.findFirst({
              where: { id: channelId, platform: EMAIL_PLATFORM },
              select: { id: true, status: true }
          })
        : null;
    return { channelId: channel?.id ?? null, ready: channel?.status === "connected" };
}

/** Nominate the channel that carries account mail, or clear the nomination. */
export async function setAuthMailChannel(channelId: string | null): Promise<{ error?: string }> {
    if (channelId === null) {
        await setSetting(CHANNEL_KEY, null);
        return {};
    }
    const channel = await prisma.channel.findFirst({
        where: { id: channelId, platform: EMAIL_PLATFORM },
        select: { id: true }
    });
    if (!channel) return { error: "That email channel no longer exists." };
    await setSetting(CHANNEL_KEY, channel.id);
    return {};
}

/**
 * Send one account message. Returns the reason it could not go rather than
 * throwing, so a caller can decide whether that is fatal - for a verification
 * link it is worth telling the user; for a best-effort notice it is not.
 */
export async function sendAuthEmail(message: EmailMessage): Promise<{ error?: string }> {
    const { channelId } = await getAuthMailStatus();
    if (!channelId) return { error: "Polaris has no email channel configured to send from." };
    return sendThroughChannel(channelId, message);
}
