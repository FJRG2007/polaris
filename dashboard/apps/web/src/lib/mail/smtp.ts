/**
 * Delivery through a mail server the operator already runs, or a provider's SMTP
 * endpoint. The one provider that needs a real client rather than an HTTPS call,
 * because SMTP is a stateful conversation with its own TLS upgrade.
 *
 * The transport is built per send rather than pooled: Polaris sends a handful of
 * messages a day (verification, a reset, a sign-in code), so a held-open
 * connection would cost more in idle sockets than it saves in handshakes.
 */

import { createTransport } from "nodemailer";
import { formatFrom, type SmtpConfig } from "@polaris/core";
import type { EmailMessage } from "./types";

/** Port 465 speaks TLS from the first byte; everything else starts in the clear
 *  and upgrades with STARTTLS. */
const IMPLICIT_TLS_PORT = 465;

export async function sendWithSmtp(config: SmtpConfig, secret: string, message: EmailMessage): Promise<void> {
    const transport = createTransport({
        host: config.host,
        port: config.port,
        secure: config.port === IMPLICIT_TLS_PORT,
        auth: { user: config.user, pass: secret },
        // A server that offers STARTTLS must be taken up on it: without this a
        // downgrade would send the password over a plain socket.
        requireTLS: config.port !== IMPLICIT_TLS_PORT,
        connectionTimeout: 15_000,
        greetingTimeout: 15_000,
        socketTimeout: 30_000
    });
    try {
        await transport.sendMail({
            from: formatFrom(config),
            to: message.to,
            subject: message.subject,
            text: message.text,
            ...(message.html ? { html: message.html } : {})
        });
    } finally {
        transport.close();
    }
}
