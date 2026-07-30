/**
 * The catalogue of connectable messaging channels: what each one is called, what
 * it costs you, and what it needs to come online. Everything that offers a
 * channel reads from here - the connect dialog and the channel marketplace - so a
 * new platform is a catalogue entry rather than a form to keep in step.
 */

import type { ReactElement } from "react";
import type { Platform } from "@polaris/messaging";
import { DiscordLogo, SlackLogo, TelegramLogo, WhatsAppLogo } from "./channel-logos";

export type ChannelKind =
    | "telegram"
    | "whatsapp-cloud"
    | "whatsapp-web"
    | "discord"
    | "discord-webhook"
    | "slack"
    | "slack-webhook";

export const CHANNEL_PLATFORM: Record<ChannelKind, Platform> = {
    telegram: "telegram",
    "whatsapp-cloud": "whatsapp",
    "whatsapp-web": "whatsapp",
    discord: "discord",
    "discord-webhook": "discord",
    slack: "slack",
    "slack-webhook": "slack"
};

export const CHANNEL_PROVIDER: Record<ChannelKind, string | null> = {
    telegram: null,
    "whatsapp-cloud": "whatsapp-cloud",
    "whatsapp-web": "whatsapp-web",
    discord: null,
    "discord-webhook": "discord-webhook",
    slack: null,
    "slack-webhook": "slack-webhook"
};

export interface ChannelKindMeta {
    kind: ChannelKind;
    name: string;
    tagline: string;
    /** Brand color for the logo tile; also tints the logo (currentColor). */
    color: string;
    Logo: (props: { className?: string }) => ReactElement;
    badge?: string;
    /** Label for the token field; omit for channels that need no upfront token (QR). */
    tokenLabel?: string;
    tokenPlaceholder?: string;
    /** WhatsApp Cloud also needs a phone-number id. */
    needsPhoneNumberId?: boolean;
    /** One line shown under the form explaining where to get the credentials. */
    help: string;
}

// The channel marketplace: every surface renders one card per entry, so new
// channels are added here without touching a form. Order is the display order.
export const CHANNEL_CATALOG: ChannelKindMeta[] = [
    {
        kind: "whatsapp-web",
        name: "WhatsApp (QR)",
        tagline: "Free. Links your phone by QR - unofficial, carries a ban risk.",
        color: "#25D366",
        Logo: WhatsAppLogo,
        badge: "Free",
        help: "Scan a QR with your phone to link it. Free but unofficial - use a spare number, not your main one."
    },
    {
        kind: "whatsapp-cloud",
        name: "WhatsApp Cloud",
        tagline: "Official Meta API. Native buttons and templates, paid.",
        color: "#25D366",
        Logo: WhatsAppLogo,
        badge: "Official",
        tokenLabel: "Access token",
        tokenPlaceholder: "EAAG...",
        needsPhoneNumberId: true,
        help: "Meta access token + phone-number id from the WhatsApp API setup page. Point its webhook at this Polaris."
    },
    {
        kind: "telegram",
        name: "Telegram",
        tagline: "A @BotFather bot. Buttons and inline menus.",
        color: "#229ED9",
        Logo: TelegramLogo,
        tokenLabel: "Bot token",
        tokenPlaceholder: "123456:ABC-DEF...",
        help: "Create a bot with @BotFather in Telegram and paste the token it gives you."
    },
    {
        kind: "discord",
        name: "Discord",
        tagline: "A bot application. Buttons and select menus.",
        color: "#5865F2",
        Logo: DiscordLogo,
        tokenLabel: "Bot token",
        tokenPlaceholder: "Bot token from the Developer Portal",
        help: "Create an app and bot in the Discord Developer Portal and paste the bot token. Polaris then shows you what is left to switch on."
    },
    {
        kind: "discord-webhook",
        name: "Discord webhook",
        tagline: "One-way alerts to a channel, no bot needed.",
        color: "#5865F2",
        Logo: DiscordLogo,
        badge: "Send-only",
        tokenLabel: "Webhook URL",
        tokenPlaceholder: "https://discord.com/api/webhooks/...",
        help: "In Discord: the channel's Edit > Integrations > Webhooks > New Webhook > Copy Webhook URL."
    },
    {
        kind: "slack",
        name: "Slack",
        tagline: "A workspace app. Blocks and interactive actions.",
        color: "#E01E5A",
        Logo: SlackLogo,
        tokenLabel: "Bot token",
        tokenPlaceholder: "xoxb-...",
        help: "Install a Slack app to your workspace and paste its Bot User OAuth token (starts with xoxb-)."
    },
    {
        kind: "slack-webhook",
        name: "Slack webhook",
        tagline: "One-way alerts to a channel, no app token.",
        color: "#E01E5A",
        Logo: SlackLogo,
        badge: "Send-only",
        tokenLabel: "Webhook URL",
        tokenPlaceholder: "https://hooks.slack.com/services/...",
        help: "Create an Incoming Webhook in your Slack app and paste its URL."
    }
];

export const CHANNEL_META: Record<ChannelKind, ChannelKindMeta> = Object.fromEntries(
    CHANNEL_CATALOG.map((meta) => [meta.kind, meta])
) as Record<ChannelKind, ChannelKindMeta>;

export interface PlatformGroup {
    platform: Platform;
    name: string;
    tagline: string;
    color: string;
    Logo: (props: { className?: string }) => ReactElement;
    /** The connectable variants for this platform, in display order. */
    variants: ChannelKind[];
}

// The dialog's connect flow is two steps: pick a platform, then its variant (bot
// vs webhook, QR vs the official API). Platforms with a single variant skip
// straight to the form.
export const PLATFORM_GROUPS: PlatformGroup[] = [
    {
        platform: "whatsapp",
        name: "WhatsApp",
        tagline: "Your number by QR, or the official Cloud API.",
        color: "#25D366",
        Logo: WhatsAppLogo,
        variants: ["whatsapp-web", "whatsapp-cloud"]
    },
    {
        platform: "telegram",
        name: "Telegram",
        tagline: "A @BotFather bot with buttons and menus.",
        color: "#229ED9",
        Logo: TelegramLogo,
        variants: ["telegram"]
    },
    {
        platform: "discord",
        name: "Discord",
        tagline: "A bot for two-way chat, or a webhook for alerts.",
        color: "#5865F2",
        Logo: DiscordLogo,
        variants: ["discord", "discord-webhook"]
    },
    {
        platform: "slack",
        name: "Slack",
        tagline: "A workspace bot, or a webhook for alerts.",
        color: "#E01E5A",
        Logo: SlackLogo,
        variants: ["slack", "slack-webhook"]
    }
];
