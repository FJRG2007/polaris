/**
 * The catalogue of connectable messaging channels: what each one is called, what
 * it costs you, and what it needs to come online. Everything that offers a
 * channel reads from here - the connect dialog and the channel marketplace - so a
 * new platform is a catalogue entry rather than a form to keep in step.
 */

import type { ReactElement } from "react";
import type { Platform } from "@polaris/messaging";
import type { NamespaceTranslator } from "@/lib/i18n/types";
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
// A function of `t` so the copy is drawn in the reader's language.
export function channelCatalog(t: NamespaceTranslator<"admin">): ChannelKindMeta[] {
    return [
        {
            kind: "whatsapp-web",
            name: t("inbox.catalog.whatsappWeb.name"),
            tagline: t("inbox.catalog.whatsappWeb.tagline"),
            color: "#25D366",
            Logo: WhatsAppLogo,
            badge: t("inbox.catalog.badges.free"),
            help: t("inbox.catalog.whatsappWeb.help")
        },
        {
            kind: "whatsapp-cloud",
            name: t("inbox.catalog.whatsappCloud.name"),
            tagline: t("inbox.catalog.whatsappCloud.tagline"),
            color: "#25D366",
            Logo: WhatsAppLogo,
            badge: t("inbox.catalog.badges.official"),
            tokenLabel: t("inbox.catalog.tokens.accessToken"),
            tokenPlaceholder: "EAAG...",
            needsPhoneNumberId: true,
            help: t("inbox.catalog.whatsappCloud.help")
        },
        {
            kind: "telegram",
            name: "Telegram",
            tagline: t("inbox.catalog.telegram.tagline"),
            color: "#229ED9",
            Logo: TelegramLogo,
            tokenLabel: t("inbox.catalog.tokens.botToken"),
            tokenPlaceholder: "123456:ABC-DEF...",
            help: t("inbox.catalog.telegram.help")
        },
        {
            kind: "discord",
            name: "Discord",
            tagline: t("inbox.catalog.discord.tagline"),
            color: "#5865F2",
            Logo: DiscordLogo,
            tokenLabel: t("inbox.catalog.tokens.botToken"),
            tokenPlaceholder: t("inbox.catalog.discord.tokenPlaceholder"),
            help: t("inbox.catalog.discord.help")
        },
        {
            kind: "discord-webhook",
            name: t("inbox.catalog.discordWebhook.name"),
            tagline: t("inbox.catalog.discordWebhook.tagline"),
            color: "#5865F2",
            Logo: DiscordLogo,
            badge: t("inbox.catalog.badges.sendOnly"),
            tokenLabel: t("inbox.catalog.tokens.webhookUrl"),
            tokenPlaceholder: "https://discord.com/api/webhooks/...",
            help: t("inbox.catalog.discordWebhook.help")
        },
        {
            kind: "slack",
            name: "Slack",
            tagline: t("inbox.catalog.slack.tagline"),
            color: "#E01E5A",
            Logo: SlackLogo,
            tokenLabel: t("inbox.catalog.tokens.botToken"),
            tokenPlaceholder: "xoxb-...",
            help: t("inbox.catalog.slack.help")
        },
        {
            kind: "slack-webhook",
            name: t("inbox.catalog.slackWebhook.name"),
            tagline: t("inbox.catalog.slackWebhook.tagline"),
            color: "#E01E5A",
            Logo: SlackLogo,
            badge: t("inbox.catalog.badges.sendOnly"),
            tokenLabel: t("inbox.catalog.tokens.webhookUrl"),
            tokenPlaceholder: "https://hooks.slack.com/services/...",
            help: t("inbox.catalog.slackWebhook.help")
        }
    ];
}

/** The catalogue keyed by kind, in the reader's language. */
export function channelMeta(t: NamespaceTranslator<"admin">): Record<ChannelKind, ChannelKindMeta> {
    return Object.fromEntries(channelCatalog(t).map((meta) => [meta.kind, meta])) as Record<
        ChannelKind,
        ChannelKindMeta
    >;
}

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
export function platformGroups(t: NamespaceTranslator<"admin">): PlatformGroup[] {
    return [
        {
            platform: "whatsapp",
            name: "WhatsApp",
            tagline: t("inbox.catalog.groups.whatsapp"),
            color: "#25D366",
            Logo: WhatsAppLogo,
            variants: ["whatsapp-web", "whatsapp-cloud"]
        },
        {
            platform: "telegram",
            name: "Telegram",
            tagline: t("inbox.catalog.groups.telegram"),
            color: "#229ED9",
            Logo: TelegramLogo,
            variants: ["telegram"]
        },
        {
            platform: "discord",
            name: "Discord",
            tagline: t("inbox.catalog.groups.discord"),
            color: "#5865F2",
            Logo: DiscordLogo,
            variants: ["discord", "discord-webhook"]
        },
        {
            platform: "slack",
            name: "Slack",
            tagline: t("inbox.catalog.groups.slack"),
            color: "#E01E5A",
            Logo: SlackLogo,
            variants: ["slack", "slack-webhook"]
        }
    ];
}
