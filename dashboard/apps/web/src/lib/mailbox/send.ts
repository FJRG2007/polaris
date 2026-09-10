/**
 * Putting a message on the wire, and putting the same bytes in Sent.
 *
 * The message is built once, as MIME, and those exact bytes are what is handed
 * to SMTP and what is appended to the Sent folder. Building it twice - once for
 * sending and once for the copy - is how a client ends up with a Sent folder
 * that does not match what the other person received, which is the kind of thing
 * nobody notices until it matters.
 *
 * What is deliberately not done here is as important as what is:
 *
 * - **No tracking pixel, ever.** This app blocks other people's; writing one
 *   would be indefensible.
 * - **No read receipt unless somebody explicitly asked for one** on that
 *   message, and the request is a header the other client is free to ignore -
 *   which is what Polaris does with them in the other direction.
 * - **Nothing is added to the body.** No footer, no "sent from", no link back
 *   here. What was written is what is sent.
 */

import { marked } from "marked";
import * as core from "@polaris/core";
import { createTransport } from "nodemailer";
import type Mail from "nodemailer/lib/mailer";
import { asMailFailure, isLoopback } from "./imap";
import MailComposer from "nodemailer/lib/mail-composer";
import { mailCredential, type MailCredentialSource } from "./credentials";

/** What an account has to carry to send. */
export interface MailSendSource extends MailCredentialSource {
    readonly smtpHost: string;
    readonly smtpPort: number;
    readonly smtpSecurity: string;
}

/** Port 465 speaks TLS from the first byte; everything else opens in the clear
 *  and upgrades. The same rule the transactional sender uses. */
const IMPLICIT_TLS_PORT = 465;

const CONNECT_TIMEOUT_MS = 20_000;
const SOCKET_TIMEOUT_MS = 60_000;

function transportFor(account: MailSendSource, credential: Awaited<ReturnType<typeof mailCredential>>) {
    return createTransport({
        host: account.smtpHost,
        port: account.smtpPort,
        secure: account.smtpSecurity === "tls" || account.smtpPort === IMPLICIT_TLS_PORT,
        auth:
            credential.kind === "password"
                ? { user: credential.user, pass: credential.pass }
                : { type: "OAuth2" as const, user: credential.user, accessToken: credential.accessToken },
        // A server that offers STARTTLS is taken up on it: without this a
        // downgrade would put the credential on a plain socket.
        requireTLS: account.smtpSecurity !== "tls" && account.smtpPort !== IMPLICIT_TLS_PORT,
        connectionTimeout: CONNECT_TIMEOUT_MS,
        greetingTimeout: CONNECT_TIMEOUT_MS,
        socketTimeout: SOCKET_TIMEOUT_MS,
        // Same rule as IMAP: a bridge on this machine signs its own certificate
        // by design, and nowhere else is this relaxed.
        ...(isLoopback(account.smtpHost) ? { tls: { rejectUnauthorized: false } } : {})
    });
}

/** Whether the outgoing server would accept this account. One handshake, no
 *  message. Used by the account form so a mailbox that can read but not send is
 *  found out on the form rather than on somebody's first reply. */
export async function checkSmtp(account: MailSendSource): Promise<void> {
    const credential = await mailCredential(account);
    const transport = transportFor(account, credential);
    try {
        await transport.verify();
    } catch (caught) {
        throw asMailFailure(caught);
    } finally {
        transport.close();
    }
}

/** One outgoing message, as this app holds it before it becomes MIME. */
export interface OutgoingMessage {
    readonly from: core.MailAddress;
    readonly to: readonly core.MailAddress[];
    readonly cc: readonly core.MailAddress[];
    readonly bcc: readonly core.MailAddress[];
    readonly replyTo: string;
    readonly subject: string;
    /** Markdown, which is what every editor in Polaris produces. */
    readonly body: string;
    readonly attachments: readonly {
        readonly filename: string;
        readonly contentType: string;
        readonly content: Buffer;
        readonly cid?: string;
    }[];
    /** The Message-Id this answers, with its angle brackets. */
    readonly inReplyTo: string;
    /** The conversation so far, oldest first, with angle brackets. */
    readonly references: readonly string[];
    readonly requestReceipt: boolean;
}

/**
 * The HTML half of a message, from the Markdown somebody wrote.
 *
 * Mail clients are a decade behind browsers, so this is deliberately plain: no
 * stylesheet, no class names, no layout. What survives everywhere is a document
 * with paragraphs in it, and anything cleverer is a message that renders as a
 * wall of text in Outlook.
 */
function htmlFrom(markdown: string): string {
    const rendered = marked.parse(markdown, { async: false, gfm: true, breaks: true });
    return `<!doctype html><html><body>${rendered}</body></html>`;
}

/**
 * The plain-text half.
 *
 * Markdown is already the plain-text version of itself, which is the whole
 * reason it is what gets stored: a client that refuses HTML gets something a
 * person wrote rather than tags with the angle brackets stripped out.
 */
function textFrom(markdown: string): string {
    return markdown;
}

/**
 * Build the MIME bytes once.
 *
 * `messageId` names the message where the caller must be able to find it again -
 * a draft's copy on the server - and is otherwise left to the composer to make
 * up. `keepBcc` is for that same copy: a draft somebody picks up in another
 * client must still have its blind copies, and it is in their own mailbox, so
 * nobody else reads the header. Anything sent never keeps it.
 */
export async function composeMime(
    message: OutgoingMessage,
    extra: { messageId?: string; keepBcc?: boolean } = {}
): Promise<Buffer> {
    const options: Mail.Options = {
        ...(extra.messageId ? { messageId: extra.messageId } : {}),
        from: core.formatAddress(message.from),
        to: message.to.map(core.formatAddress),
        ...(message.cc.length > 0 ? { cc: message.cc.map(core.formatAddress) } : {}),
        ...(message.bcc.length > 0 ? { bcc: message.bcc.map(core.formatAddress) } : {}),
        ...(message.replyTo ? { replyTo: message.replyTo } : {}),
        subject: message.subject,
        text: textFrom(message.body),
        html: htmlFrom(message.body),
        ...(message.inReplyTo ? { inReplyTo: message.inReplyTo } : {}),
        ...(message.references.length > 0 ? { references: [...message.references] } : {}),
        attachments: message.attachments.map((file) => ({
            filename: file.filename,
            contentType: file.contentType,
            content: file.content,
            ...(file.cid ? { cid: file.cid, contentDisposition: "inline" as const } : {})
        })),
        // Both headers, because clients are split on which one they honour, and
        // only when the sender asked on this message.
        ...(message.requestReceipt
            ? {
                  headers: {
                      "Disposition-Notification-To": message.from.address,
                      "Return-Receipt-To": message.from.address
                  }
              }
            : {})
    };
    const node = new MailComposer(options).compile();
    if (extra.keepBcc) node.keepBcc = true;
    return node.build();
}

/**
 * Send it.
 *
 * `envelope` is passed explicitly so the Bcc recipients are on the envelope and
 * not in the headers: a Bcc that reaches the header is a Bcc that everybody can
 * read, which is the one mistake in a mail client that cannot be taken back.
 * MailComposer strips the Bcc header from the built message for exactly this
 * reason, so the envelope is the only place it is stated.
 */
export async function sendMime(
    account: MailSendSource,
    message: OutgoingMessage,
    mime: Buffer
): Promise<void> {
    const credential = await mailCredential(account);
    const transport = transportFor(account, credential);
    try {
        await transport.sendMail({
            envelope: {
                from: message.from.address,
                to: [...message.to, ...message.cc, ...message.bcc].map((entry) => entry.address)
            },
            raw: mime
        });
    } catch (caught) {
        throw asMailFailure(caught);
    } finally {
        transport.close();
    }
}
