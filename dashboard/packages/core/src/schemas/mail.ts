/**
 * The outbound-email providers Polaris can send through, and the shape each one
 * needs to be configured with. One catalogue, shared by the connect dialog that
 * renders the fields, the server action that validates them, and the senders
 * that use them - so a provider is described in exactly one place.
 *
 * Every provider is split the same way: one secret (an API key or a password)
 * that is envelope-encrypted and never read back, and the rest of the settings,
 * which are not sensitive and are stored in the clear so the UI can show them.
 *
 * Providers differ in what they demand of the sending address, which is the
 * thing that actually decides whether an operator can use one. Resend and SES
 * want a domain proved by DNS; Brevo and Mailjet only want the single address
 * confirmed by clicking a link in it, so they work from a personal mailbox with
 * no DNS at all; SMTP takes whatever server the operator already has.
 */

import { z } from "zod";
import { emailField } from "./auth.js";

/**
 * The Channel.platform value that marks a row as an email sender. Email channels
 * share the messaging channels' table and their page, but the bridge never runs
 * them - the web process sends the mail itself.
 */
export const EMAIL_PLATFORM = "email";

export const MAIL_PROVIDERS = ["smtp", "resend", "brevo", "mailjet", "ses"] as const;

export type MailProvider = (typeof MAIL_PROVIDERS)[number];

/** One field of a provider's configuration, as the connect dialog renders it. */
export interface MailProviderField {
    name: string;
    label: string;
    /** `password` masks the value; `number` gets a numeric input. */
    type?: "text" | "password" | "number";
    placeholder?: string;
    hint?: string;
    optional?: boolean;
}

/** What an operator needs to know before picking a provider. */
export interface MailProviderInfo {
    id: MailProvider;
    label: string;
    /** One line, shown on the provider tile. */
    summary: string;
    /** What the provider requires of the sending address. */
    senderRequirement: string;
    /** Where to get the credential. */
    docsUrl: string;
    /** The secret field: an API key or a password. Absent for none. */
    secretLabel: string;
    secretHint: string;
    /** Everything else, in the order it should be rendered. */
    fields: MailProviderField[];
}

/** The address every provider sends as, and the optional display name. */
const FROM_FIELDS: MailProviderField[] = [
    {
        name: "from",
        label: "From address",
        placeholder: "polaris@example.com",
        hint: "Mail arrives from this address. It has to be one the provider lets you send as."
    },
    {
        name: "fromName",
        label: "From name",
        placeholder: "Polaris",
        optional: true
    }
];

export const MAIL_PROVIDER_INFO: Record<MailProvider, MailProviderInfo> = {
    smtp: {
        id: "smtp",
        label: "SMTP server",
        summary: "Any mail server you already have, including a provider's SMTP endpoint.",
        senderRequirement: "Whatever your server accepts.",
        docsUrl: "https://nodemailer.com/smtp/",
        secretLabel: "Password",
        secretHint: "The password or app password for the account above.",
        fields: [
            { name: "host", label: "Host", placeholder: "smtp.example.com" },
            {
                name: "port",
                label: "Port",
                type: "number",
                placeholder: "587",
                hint: "587 for STARTTLS, 465 for implicit TLS, 25 unencrypted."
            },
            { name: "user", label: "Username", placeholder: "polaris@example.com" },
            ...FROM_FIELDS
        ]
    },
    resend: {
        id: "resend",
        label: "Resend",
        summary: "Developer-first API. 3,000 mails a month free.",
        senderRequirement: "A domain verified by DNS, or onboarding@resend.dev to your own address only.",
        docsUrl: "https://resend.com/docs/api-reference/emails/send-email",
        secretLabel: "API key",
        secretHint: "From Resend > API Keys, with Sending access.",
        fields: FROM_FIELDS
    },
    brevo: {
        id: "brevo",
        label: "Brevo",
        summary: "300 mails a day free, and no domain needed.",
        senderRequirement: "One address, confirmed by clicking the link Brevo sends to it. No DNS.",
        docsUrl: "https://developers.brevo.com/reference/sendtransacemail",
        secretLabel: "API key",
        secretHint: "From Brevo > SMTP & API > API keys. Starts with xkeysib-.",
        fields: FROM_FIELDS
    },
    mailjet: {
        id: "mailjet",
        label: "Mailjet",
        summary: "200 mails a day free, and no domain needed.",
        senderRequirement: "One address, confirmed by clicking the link Mailjet sends to it. No DNS.",
        docsUrl: "https://dev.mailjet.com/email/guides/send-api-v31/",
        secretLabel: "Secret key",
        secretHint: "The Secret Key from Mailjet > API Key Management.",
        fields: [
            {
                name: "apiKey",
                label: "API key",
                hint: "The public API Key that pairs with the secret key."
            },
            ...FROM_FIELDS
        ]
    },
    ses: {
        id: "ses",
        label: "Amazon SES",
        summary: "AWS Simple Email Service. Cheapest at volume.",
        senderRequirement: "A domain or address verified in SES, in the same region.",
        docsUrl: "https://docs.aws.amazon.com/ses/latest/dg/send-email-api.html",
        secretLabel: "Secret access key",
        secretHint: "An IAM user or role key with ses:SendEmail.",
        fields: [
            { name: "accessKeyId", label: "Access key id", placeholder: "AKIA..." },
            {
                name: "region",
                label: "Region",
                placeholder: "eu-west-1",
                hint: "The region the sending identity is verified in."
            },
            ...FROM_FIELDS
        ]
    }
};

/** A trimmed, non-empty setting value. */
const setting = (max = 256) => z.string().trim().min(1).max(max);

/** The display name on the From header. Empty means send the bare address. */
const fromNameField = z.string().trim().max(120).optional();

const smtpConfigSchema = z.object({
    host: setting(255),
    // Bare TCP ports; 465 is implicit TLS, everything else is upgraded with
    // STARTTLS by the sender.
    port: z.coerce.number().int().min(1).max(65535),
    user: setting(320),
    from: emailField,
    fromName: fromNameField
});

const resendConfigSchema = z.object({ from: emailField, fromName: fromNameField });

const brevoConfigSchema = z.object({ from: emailField, fromName: fromNameField });

const mailjetConfigSchema = z.object({
    apiKey: setting(128),
    from: emailField,
    fromName: fromNameField
});

const sesConfigSchema = z.object({
    accessKeyId: setting(128),
    // Region codes are lowercase letters, digits and hyphens (eu-west-1).
    region: z
        .string()
        .trim()
        .min(1)
        .max(64)
        .regex(/^[a-z0-9-]+$/, "Enter a region code like eu-west-1"),
    from: emailField,
    fromName: fromNameField
});

/** The non-secret configuration for each provider, keyed by provider id. */
export const MAIL_CONFIG_SCHEMA = {
    smtp: smtpConfigSchema,
    resend: resendConfigSchema,
    brevo: brevoConfigSchema,
    mailjet: mailjetConfigSchema,
    ses: sesConfigSchema
} as const;

export type SmtpConfig = z.infer<typeof smtpConfigSchema>;
export type ResendConfig = z.infer<typeof resendConfigSchema>;
export type BrevoConfig = z.infer<typeof brevoConfigSchema>;
export type MailjetConfig = z.infer<typeof mailjetConfigSchema>;
export type SesConfig = z.infer<typeof sesConfigSchema>;

/** Any provider's configuration, discriminated by the provider it belongs to. */
export type MailConfig =
    | { provider: "smtp"; settings: SmtpConfig }
    | { provider: "resend"; settings: ResendConfig }
    | { provider: "brevo"; settings: BrevoConfig }
    | { provider: "mailjet"; settings: MailjetConfig }
    | { provider: "ses"; settings: SesConfig };

/**
 * Validate a provider's settings against its own schema. The provider decides
 * which shape applies, so an unknown provider is a failure rather than a
 * permissive pass - a channel is only ever written from a shape checked here.
 */
export function parseMailConfig(
    provider: string,
    settings: unknown
): { ok: true; value: MailConfig } | { ok: false; error: string } {
    if (!isMailProvider(provider)) return { ok: false, error: "Unknown email provider." };
    const parsed = MAIL_CONFIG_SCHEMA[provider].safeParse(settings);
    if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const field = issue?.path.join(".");
        return { ok: false, error: field ? `${field}: ${issue?.message}` : (issue?.message ?? "Check the form.") };
    }
    return { ok: true, value: { provider, settings: parsed.data } as MailConfig };
}

/** Whether a string names a provider Polaris can send through. */
export function isMailProvider(value: string): value is MailProvider {
    return (MAIL_PROVIDERS as readonly string[]).includes(value);
}

/** The From header for a configuration: `Name <address>`, or the bare address. */
export function formatFrom(settings: { from: string; fromName?: string }): string {
    const name = settings.fromName?.trim();
    if (!name) return settings.from;
    // Quote the display name so a comma or colon in it cannot split the header.
    return `"${name.replace(/["\\]/g, "")}" <${settings.from}>`;
}
