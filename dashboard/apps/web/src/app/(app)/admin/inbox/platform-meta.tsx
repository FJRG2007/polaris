/**
 * Shared per-platform presentation and peer-id helpers for the Inbox surfaces
 * (conversations, channels, contacts). Kept in one place so the channel bar, the
 * Channels page and the Contacts CRM render the same brand marks, labels and hints
 * and agree on how a stored handle reads and round-trips.
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

/** Per-platform hint for the recipient id when starting a chat or saving a handle. */
export function peerHint(t: NamespaceTranslator<"admin">, platform: string): string | undefined {
    switch (platform) {
        case "whatsapp":
            return t("inbox.peerHints.whatsapp");
        case "telegram":
            return t("inbox.peerHints.telegram");
        case "discord":
            return t("inbox.peerHints.discord");
        case "slack":
            return t("inbox.peerHints.slack");
        default:
            return undefined;
    }
}

// Brand names only, the same in every language.
export const PLATFORM_OPTIONS = [
    { value: "whatsapp", label: "WhatsApp" }, // i18n-ignore
    { value: "telegram", label: "Telegram" }, // i18n-ignore
    { value: "discord", label: "Discord" }, // i18n-ignore
    { value: "slack", label: "Slack" } // i18n-ignore
];

/** How a Discord handle is targeted: a server text channel or a user DM. The wire
 *  form is a bare snowflake for a channel (back-compatible) and `user:<id>` for a
 *  DM, so the bridge adapter can route it without a separate flag. */
export type DiscordTarget = "channel" | "user";

export function parseDiscordPeer(peerId: string): { target: DiscordTarget; id: string } {
    const value = peerId.trim();
    if (value.startsWith("user:")) return { target: "user", id: value.slice("user:".length) };
    if (value.startsWith("channel:"))
        return { target: "channel", id: value.slice("channel:".length) };
    return { target: "channel", id: value };
}

export function encodeDiscordPeer(target: DiscordTarget, id: string): string {
    const trimmed = id.trim();
    if (!trimmed) return "";
    return target === "user" ? `user:${trimmed}` : trimmed;
}

/** A stored handle in human form for display: a WhatsApp JID (34657580303@c.us)
 *  reads as the phone number (+34657580303); a Discord DM reads as "DM <id>" and a
 *  channel as "#<id>"; other platforms show the id unchanged. */
export function humanPeerId(platform: string, peerId: string): string {
    if (platform === "whatsapp" && peerId.endsWith("@c.us")) {
        const digits = peerId.slice(0, -"@c.us".length);
        return /^\d+$/.test(digits) ? `+${digits}` : digits;
    }
    if (platform === "discord") {
        const { target, id } = parseDiscordPeer(peerId);
        return target === "user" ? `DM ${id}` : `#${id}`;
    }
    return peerId;
}

/** The editable/sendable form of a stored handle for a text input: a WhatsApp JID
 *  reads as its phone number (which round-trips server-side); other platforms keep
 *  the raw stored id, including Discord's user:/channel: encoding. */
export function editablePeer(platform: string, peerId: string): string {
    return platform === "whatsapp" ? humanPeerId(platform, peerId) : peerId;
}
