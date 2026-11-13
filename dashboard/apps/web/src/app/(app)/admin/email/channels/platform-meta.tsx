/**
 * Shared per-platform presentation for the channel surfaces (the Channels page,
 * the senders list, the bridge's app page), so each renders the same brand
 * marks, labels and status tones.
 */

import type { ReactElement } from "react";
import type { NamespaceTranslator } from "@/lib/i18n/types";
import { DiscordLogo, EmailLogo, SlackLogo, TelegramLogo, WhatsAppLogo } from "./channel-logos";

/** The brand names, which read the same in every language. */
export const PLATFORM_LABEL: Record<string, string> = {
    whatsapp: "WhatsApp",
    telegram: "Telegram",
    discord: "Discord",
    slack: "Slack"
};

/** A platform's name for display: the brand, or the word for email in the
 *  reader's language; an unknown platform shows as stored. */
export function platformLabel(t: NamespaceTranslator<"admin">, platform: string): string {
    if (platform === "email") return t("inbox.platforms.email");
    return PLATFORM_LABEL[platform] ?? platform;
}

/** The email sender's mark, named separately so the Channels page can render it
 *  without a lookup that may miss. */
export const EMAIL_CHANNEL_MARK = { Logo: EmailLogo, color: "#8B5CF6" };

/** Brand logo + color per platform, for distinguishing channels at a glance. */
export const PLATFORM_LOGO: Record<
    string,
    { Logo: (props: { className?: string }) => ReactElement; color: string }
> = {
    whatsapp: { Logo: WhatsAppLogo, color: "#25D366" },
    telegram: { Logo: TelegramLogo, color: "#229ED9" },
    discord: { Logo: DiscordLogo, color: "#5865F2" },
    slack: { Logo: SlackLogo, color: "#E01E5A" },
    email: EMAIL_CHANNEL_MARK
};

export const CHANNEL_STATUS_TONE: Record<string, string> = {
    connected: "border-success-edge text-success",
    connecting: "border-warning-edge text-warning",
    qr: "border-warning-edge text-warning",
    error: "border-danger-edge text-danger", // i18n-ignore
    disconnected: "border-danger-edge text-danger"
};
