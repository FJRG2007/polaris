/**
 * Checking a provider's credentials without sending anything.
 *
 * Every provider here has a cheap read endpoint that fails on a bad key, so an
 * operator finds out the key is wrong while they are still looking at the form -
 * rather than weeks later, when the first password reset silently does not
 * arrive. It proves the credential, not the sending address: whether the From
 * address is allowed is only settled by a real send, which is what the test
 * message on the channel is for.
 */

import { createTransport } from "nodemailer";
import type { MailAccount } from "./types";

/** GET with an auth header, turning anything but a 2xx into a readable error. */
async function check(provider: string, url: string, headers: Record<string, string>): Promise<void> {
    let res: Response;
    try {
        res = await fetch(url, { method: "GET", cache: "no-store", headers });
    } catch (caught) {
        throw new Error(
            caught instanceof Error ? `${provider} unreachable: ${caught.message}` : `${provider} unreachable`
        );
    }
    if (res.ok) return;
    if (res.status === 401 || res.status === 403) throw new Error(`${provider} rejected that key.`);
    throw new Error(`${provider} answered HTTP ${res.status}.`);
}

/**
 * Confirm the credentials work. Throws with the reason when they do not; returns
 * quietly when they do.
 */
export async function verifyMailAccount(account: MailAccount): Promise<void> {
    const { config, secret } = account;
    switch (config.provider) {
        case "resend":
            return check("Resend", "https://api.resend.com/domains", { Authorization: `Bearer ${secret}` });
        case "brevo":
            return check("Brevo", "https://api.brevo.com/v3/account", { "api-key": secret });
        case "mailjet": {
            const credentials = Buffer.from(`${config.settings.apiKey}:${secret}`).toString("base64");
            return check("Mailjet", "https://api.mailjet.com/v3/REST/sender?Limit=1", {
                Authorization: `Basic ${credentials}`
            });
        }
        case "ses":
            // SES has no unsigned read endpoint, and signing a second request
            // shape to learn what a send would tell us anyway is not worth the
            // code. The first test message is the check.
            return;
        case "smtp": {
            const transport = createTransport({
                host: config.settings.host,
                port: config.settings.port,
                secure: config.settings.port === 465,
                auth: { user: config.settings.user, pass: secret },
                requireTLS: config.settings.port !== 465,
                connectionTimeout: 15_000,
                greetingTimeout: 15_000
            });
            try {
                await transport.verify();
            } catch (caught) {
                throw new Error(
                    caught instanceof Error ? `The mail server refused the login: ${caught.message}` : "The mail server refused the login."
                );
            } finally {
                transport.close();
            }
            return;
        }
    }
}
