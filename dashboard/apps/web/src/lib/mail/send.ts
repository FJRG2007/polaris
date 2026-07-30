/**
 * Sending one message through whichever provider a channel is configured with.
 *
 * The three API providers here (Resend, Brevo, Mailjet) are each a single
 * authenticated POST, so they live together; SES needs request signing and SMTP
 * needs a real client, so those have their own modules.
 *
 * Failures throw with the provider's own words wherever the provider gives any -
 * "the sender address is not verified" is the single most common reason mail
 * does not arrive, and only the provider knows to say it.
 */

import { formatFrom, type BrevoConfig, type MailjetConfig, type ResendConfig } from "@polaris/core";
import { sendWithSes } from "./ses";
import { sendWithSmtp } from "./smtp";
import type { EmailMessage, MailAccount } from "./types";

/** POST JSON and turn anything but a 2xx into an error carrying the API's text. */
async function post(
    provider: string,
    url: string,
    headers: Record<string, string>,
    body: unknown
): Promise<Response> {
    let res: Response;
    try {
        res = await fetch(url, {
            method: "POST",
            cache: "no-store",
            headers: { "Content-Type": "application/json", ...headers },
            body: JSON.stringify(body)
        });
    } catch (caught) {
        throw new Error(
            caught instanceof Error ? `${provider} unreachable: ${caught.message}` : `${provider} unreachable`
        );
    }
    if (res.ok) return res;
    const payload = (await res.json().catch(() => null)) as
        | { message?: string; error?: string; ErrorMessage?: string; Messages?: Array<{ Errors?: Array<{ ErrorMessage?: string }> }> }
        | null;
    const detail =
        payload?.message ??
        payload?.error ??
        payload?.ErrorMessage ??
        payload?.Messages?.[0]?.Errors?.[0]?.ErrorMessage;
    throw new Error(detail ?? `${provider} refused the message (HTTP ${res.status})`);
}

async function sendWithResend(config: ResendConfig, secret: string, message: EmailMessage): Promise<void> {
    await post("Resend", "https://api.resend.com/emails", { Authorization: `Bearer ${secret}` }, {
        from: formatFrom(config),
        to: [message.to],
        subject: message.subject,
        text: message.text,
        ...(message.html ? { html: message.html } : {})
    });
}

async function sendWithBrevo(config: BrevoConfig, secret: string, message: EmailMessage): Promise<void> {
    await post("Brevo", "https://api.brevo.com/v3/smtp/email", { "api-key": secret }, {
        sender: { email: config.from, ...(config.fromName ? { name: config.fromName } : {}) },
        to: [{ email: message.to }],
        subject: message.subject,
        textContent: message.text,
        ...(message.html ? { htmlContent: message.html } : {})
    });
}

async function sendWithMailjet(config: MailjetConfig, secret: string, message: EmailMessage): Promise<void> {
    // Mailjet pairs a public key with the secret over HTTP basic auth.
    const credentials = Buffer.from(`${config.apiKey}:${secret}`).toString("base64");
    const res = await post("Mailjet", "https://api.mailjet.com/v3.1/send", { Authorization: `Basic ${credentials}` }, {
        Messages: [
            {
                From: { Email: config.from, ...(config.fromName ? { Name: config.fromName } : {}) },
                To: [{ Email: message.to }],
                Subject: message.subject,
                TextPart: message.text,
                ...(message.html ? { HTMLPart: message.html } : {})
            }
        ]
    });
    // Mailjet answers 200 with a per-message status, so a refusal can arrive
    // inside a successful response.
    const payload = (await res.json().catch(() => null)) as {
        Messages?: Array<{ Status?: string; Errors?: Array<{ ErrorMessage?: string }> }>;
    } | null;
    const entry = payload?.Messages?.[0];
    if (entry && entry.Status !== "success") {
        throw new Error(entry.Errors?.[0]?.ErrorMessage ?? "Mailjet did not accept the message.");
    }
}

/** Send one message through a configured account. Throws on any refusal. */
export async function sendEmail(account: MailAccount, message: EmailMessage): Promise<void> {
    const { config, secret } = account;
    switch (config.provider) {
        case "smtp":
            return sendWithSmtp(config.settings, secret, message);
        case "resend":
            return sendWithResend(config.settings, secret, message);
        case "brevo":
            return sendWithBrevo(config.settings, secret, message);
        case "mailjet":
            return sendWithMailjet(config.settings, secret, message);
        case "ses":
            return sendWithSes(config.settings, secret, message);
    }
}
