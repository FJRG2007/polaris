/**
 * The messaging providers the Add channel picker lists.
 *
 * Each row names the platform it runs on, the provider stored with the channel
 * (absent for the bot backends, which is how channels connected before this page
 * were stored), and the fields its form asks for. `token` is always the secret:
 * it is encrypted with the master key and never sent back to the browser.
 *
 * WhatsApp Web drives an unofficial session that WhatsApp may ban, so it is
 * listed last among the WhatsApp rows, labelled with that risk, and never the
 * default; the official Business API backends come first.
 */

import type { Platform } from "@polaris/messaging";

export type MessagingFieldName =
    | "phoneNumberId"
    | "accountSid"
    | "from"
    | "contentSid"
    | "codeTemplate"
    | "codeTemplateLanguage";

export interface MessagingProviderRow {
    /** The picker's value and the logo slug. */
    id: string;
    platform: Platform;
    /** Stored on the channel; undefined for the bot backends. */
    provider: string | undefined;
    /** The brand name, which reads the same in every language. */
    name: string;
    /** Other words people search for. */
    aliases: string[];
    /** Logs in by QR rather than a credential. */
    qr?: boolean;
    /** May be banned by the platform. */
    banRisk?: boolean;
    /** Plain fields, in form order. */
    fields: { name: MessagingFieldName; optional?: boolean }[];
    /** Whether verification codes need an approved WhatsApp template. */
    template?: boolean;
}

export const MESSAGING_PROVIDERS: readonly MessagingProviderRow[] = [
    {
        id: "whatsapp-cloud",
        platform: "whatsapp",
        provider: "whatsapp-cloud",
        name: "WhatsApp Cloud API",
        aliases: ["whatsapp", "meta", "facebook", "business", "official", "cloud"],
        fields: [
            { name: "phoneNumberId" },
            { name: "codeTemplate", optional: true },
            { name: "codeTemplateLanguage", optional: true }
        ],
        template: true
    },
    {
        id: "whatsapp-twilio",
        platform: "whatsapp",
        provider: "whatsapp-twilio",
        name: "WhatsApp via Twilio",
        aliases: ["whatsapp", "twilio", "business", "official"],
        fields: [{ name: "accountSid" }, { name: "from" }, { name: "contentSid", optional: true }],
        template: true
    },
    {
        id: "whatsapp-360dialog",
        platform: "whatsapp",
        provider: "whatsapp-360dialog",
        name: "WhatsApp via 360dialog",
        aliases: ["whatsapp", "360dialog", "dialog", "business", "official"],
        fields: [
            { name: "from", optional: true },
            { name: "codeTemplate", optional: true },
            { name: "codeTemplateLanguage", optional: true }
        ],
        template: true
    },
    {
        id: "telegram",
        platform: "telegram",
        provider: undefined,
        name: "Telegram",
        aliases: ["telegram", "bot", "botfather"],
        fields: []
    },
    {
        id: "discord",
        platform: "discord",
        provider: undefined,
        name: "Discord",
        aliases: ["discord", "bot"],
        fields: []
    },
    {
        id: "discord-webhook",
        platform: "discord",
        provider: "discord-webhook",
        name: "Discord webhook",
        aliases: ["discord", "webhook"],
        fields: []
    },
    {
        id: "slack",
        platform: "slack",
        provider: undefined,
        name: "Slack",
        aliases: ["slack", "bot", "app"],
        fields: []
    },
    {
        id: "slack-webhook",
        platform: "slack",
        provider: "slack-webhook",
        name: "Slack webhook",
        aliases: ["slack", "webhook", "incoming"],
        fields: []
    },
    {
        id: "whatsapp-web",
        platform: "whatsapp",
        provider: "whatsapp-web",
        name: "WhatsApp Web",
        aliases: ["whatsapp", "web", "qr", "unofficial", "personal"],
        qr: true,
        banRisk: true,
        fields: []
    }
];

/** Where the picker starts: the official WhatsApp API, never WhatsApp Web. */
export const DEFAULT_MESSAGING_PROVIDER = "whatsapp-cloud";

/** The catalogue row a stored channel belongs to. */
export function providerRowFor(platform: string, provider: string | null): MessagingProviderRow | undefined {
    if (platform === "whatsapp") {
        const id = provider ?? "whatsapp-web";
        return MESSAGING_PROVIDERS.find((row) => row.id === id) ?? MESSAGING_PROVIDERS.find((row) => row.id === "whatsapp-web");
    }
    return MESSAGING_PROVIDERS.find((row) => row.platform === platform && row.provider === (provider ?? undefined));
}

