/**
 * The providers the Add sender picker lists, in the reader's language.
 *
 * The catalogue in core names each provider in English; a brand name stays as
 * it is, while "SMTP server" and every summary are translated here. `aliases`
 * are the other words people search for, which is how "sendinblue" finds Brevo
 * and "aws" finds Amazon SES.
 */

import type { useTranslations } from "@/components/i18n/i18n-provider";
import { MAIL_PROVIDER_INFO, MAIL_PROVIDERS, type MailProvider } from "@polaris/core";

type Translate = ReturnType<typeof useTranslations<"admin">>;

const SUMMARY_KEYS = {
    smtp: "email.providers.smtp.summary",
    resend: "email.providers.resend.summary",
    brevo: "email.providers.brevo.summary",
    mailjet: "email.providers.mailjet.summary",
    ses: "email.providers.ses.summary"
} as const satisfies Record<MailProvider, string>;

const ALIASES: Record<MailProvider, string[]> = {
    smtp: ["smtp", "server", "own", "custom", "relay"],
    resend: [],
    brevo: ["sendinblue"],
    mailjet: [],
    ses: ["aws", "amazon", "simple email service"]
};

export function providerLabel(t: Translate, provider: MailProvider): string {
    return provider === "smtp" ? t("email.providers.smtp.label") : MAIL_PROVIDER_INFO[provider].label;
}

export function providerSummary(t: Translate, provider: MailProvider): string {
    return t(SUMMARY_KEYS[provider]);
}

/** The picker's rows: every provider, with no free-tier badge (the summary says it). */
export function providerOptions(t: Translate) {
    return MAIL_PROVIDERS.map((slug) => ({
        slug,
        name: providerLabel(t, slug),
        aliases: [MAIL_PROVIDER_INFO[slug].label, ...ALIASES[slug]],
        freeTier: null
    }));
}
