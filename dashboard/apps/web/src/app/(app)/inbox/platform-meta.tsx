/**
 * Shared per-platform presentation and peer-id helpers for the Inbox surfaces
 * (conversations, channels, contacts). Kept in one place so the channel bar, the
 * Channels page and the Contacts CRM render the same brand marks, labels and hints
 * and agree on how a stored handle reads and round-trips.
 */

import type { ReactElement } from "react";
import { DiscordLogo, SlackLogo, TelegramLogo, WhatsAppLogo } from "./channel-logos";

export const PLATFORM_LABEL: Record<string, string> = {
    whatsapp: "WhatsApp",
    telegram: "Telegram",
    discord: "Discord",
    slack: "Slack"
};

/** Brand logo + color per platform, for distinguishing channels at a glance. */
export const PLATFORM_LOGO: Record<
    string,
    { Logo: (props: { className?: string }) => ReactElement; color: string }
> = {
    whatsapp: { Logo: WhatsAppLogo, color: "#25D366" },
    telegram: { Logo: TelegramLogo, color: "#229ED9" },
    discord: { Logo: DiscordLogo, color: "#5865F2" },
    slack: { Logo: SlackLogo, color: "#E01E5A" }
};

export const CHANNEL_STATUS_TONE: Record<string, string> = {
    connected: "border-success/40 text-success",
    connecting: "border-warning/40 text-warning",
    qr: "border-warning/40 text-warning",
    error: "border-danger/40 text-danger",
    disconnected: "border-danger/40 text-danger"
};

/** Per-platform hint for the recipient id when starting a chat or saving a handle. */
export const PEER_HINT: Record<string, string> = {
    whatsapp: "Phone number with country code, e.g. 34600111222",
    telegram:
        "Numeric chat id, not a @username. The person must have messaged the bot first (Telegram bots can't start a chat).",
    discord: "A server channel id the bot can post to, or a user id to DM (prefix a DM with user:)",
    slack: "A channel or user id"
};

export const PLATFORM_OPTIONS = [
    { value: "whatsapp", label: "WhatsApp" },
    { value: "telegram", label: "Telegram" },
    { value: "discord", label: "Discord" },
    { value: "slack", label: "Slack" }
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
