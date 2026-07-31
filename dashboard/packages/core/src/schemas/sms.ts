/**
 * The text-message senders Polaris can hand an alert to, described the same way
 * as the email providers: one secret that is envelope-encrypted and never read
 * back, and the rest of the settings in the clear so the form can show them.
 *
 * SMS is alerting only. It is deliberately not offered as a second factor - a
 * text can be read off a locked screen and a number can be moved by anyone who
 * talks a carrier into it - but for "your deploy just failed" at three in the
 * morning it is the one channel that reaches a phone with no app installed.
 */

import { z } from "zod";

/**
 * The Channel.platform value marking a row as a text-message sender. SMS
 * channels share the Channel table with mail and messaging, and reuse its
 * envelope encryption, but the bridge never runs them: the web process posts to
 * the provider itself.
 */
export const SMS_PLATFORM = "sms";

export const SMS_PROVIDERS = ["twilio"] as const;

export type SmsProvider = (typeof SMS_PROVIDERS)[number];

/** One field of a provider's configuration, as the connect dialog renders it. */
export interface SmsProviderField {
    name: string;
    label: string;
    type?: "text" | "password";
    placeholder?: string;
    hint?: string;
}

export interface SmsProviderInfo {
    id: SmsProvider;
    label: string;
    summary: string;
    docsUrl: string;
    secretLabel: string;
    secretHint: string;
    fields: SmsProviderField[];
}

export const SMS_PROVIDER_INFO: Record<SmsProvider, SmsProviderInfo> = {
    twilio: {
        id: "twilio",
        label: "Twilio",
        summary: "Pay per message, no monthly minimum. Works in most countries.",
        docsUrl: "https://www.twilio.com/docs/messaging/api/message-resource",
        secretLabel: "Auth token",
        secretHint: "From the Twilio console home, beside the Account SID.",
        fields: [
            {
                name: "accountSid",
                label: "Account SID",
                placeholder: "AC...",
                hint: "The account identifier on the Twilio console home."
            },
            {
                name: "from",
                label: "From number",
                placeholder: "+15550001111",
                hint: "A number you bought from Twilio, or an approved sender id."
            }
        ]
    }
};

const twilioConfigSchema = z.object({
    accountSid: z
        .string()
        .trim()
        .regex(/^AC[0-9a-fA-F]{32}$/, "A Twilio account SID starts with AC and is 34 characters"),
    from: z
        .string()
        .trim()
        .regex(/^\+[1-9]\d{6,14}$/, "Enter the sending number in international form, like +15550001111")
});

export const SMS_CONFIG_SCHEMA = { twilio: twilioConfigSchema } as const;

export type TwilioConfig = z.infer<typeof twilioConfigSchema>;

export type SmsConfig = { provider: "twilio"; settings: TwilioConfig };

export function isSmsProvider(value: string): value is SmsProvider {
    return (SMS_PROVIDERS as readonly string[]).includes(value);
}

/** Validate a provider's settings against its own schema, the way mail does. */
export function parseSmsConfig(
    provider: string,
    settings: unknown
): { ok: true; value: SmsConfig } | { ok: false; error: string } {
    if (!isSmsProvider(provider)) return { ok: false, error: "Unknown SMS provider." };
    const parsed = SMS_CONFIG_SCHEMA[provider].safeParse(settings);
    if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const field = issue?.path.join(".");
        return { ok: false, error: field ? `${field}: ${issue?.message}` : (issue?.message ?? "Check the form.") };
    }
    return { ok: true, value: { provider, settings: parsed.data } as SmsConfig };
}

/** The form the connect dialog submits. */
export const smsChannelInputSchema = z.object({
    name: z.string().trim().min(1).max(60),
    provider: z.enum(SMS_PROVIDERS),
    settings: z.record(z.string(), z.unknown()),
    secret: z.string().trim().max(512).optional()
});

export type SmsChannelInput = z.infer<typeof smsChannelInputSchema>;
