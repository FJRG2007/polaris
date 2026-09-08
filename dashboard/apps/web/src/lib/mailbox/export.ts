/**
 * Getting somebody's mail back out.
 *
 * The reason this exists is not symmetry with importing. It is that a mail
 * client which cannot hand back what it holds is a client nobody should put
 * anything into - and Polaris asks people for the credentials to their real
 * correspondence, which makes the bar higher rather than lower.
 *
 * Two shapes, and the difference matters:
 *
 * - **One message** is fetched from the mail server as it was sent, headers and
 *   all, and handed over byte for byte. One round trip, and the file is the
 *   message rather than a reconstruction of it.
 * - **A whole mailbox** is built from what Polaris holds, because fetching
 *   thousands of messages over IMAP is not something a download can wait for.
 *   That is a real difference and the screen says so: what comes out is every
 *   message this Polaris has, with the headers it kept, which is what somebody
 *   wants for an archive and is not a forensic copy.
 *
 * Streamed rather than assembled. A mailbox of forty thousand messages is
 * hundreds of megabytes, and building that in memory to answer one request is
 * how a dashboard falls over while somebody is looking at it.
 */

import { withImap } from "./imap";
import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { addressesFrom } from "./json";
import { ownedAccount, ownedMessages } from "./access";

/** How many rows are read at a time while an export streams. Big enough that a
 *  large mailbox is not thousands of queries, small enough that no single read
 *  is the thing that runs out of memory. */
const PAGE = 200;

/**
 * One message, exactly as its server holds it.
 *
 * `download` on the whole message rather than a part: what comes back is the
 * raw RFC 822 source, which is what a `.eml` file is. Anything reconstructed
 * from the columns would be missing headers Polaris never asked for, and the
 * point of exporting one message is usually that somebody needs those headers.
 */
export async function messageSource(userId: string, messageId: string): Promise<Buffer | null> {
    const [message] = await ownedMessages(userId, [messageId]);
    if (!message) return null;
    const folder = await prisma.mailFolder.findUnique({
        where: { id: message.folderId },
        select: { path: true }
    });
    if (!folder) return null;

    const account = await ownedAccount(userId, message.accountId);
    return withImap(account, async (client) => {
        const lock = await client.getMailboxLock(folder.path);
        try {
            const found = await client.download(String(message.uid), undefined, { uid: true });
            if (!found?.content) return null;
            const parts: Buffer[] = [];
            for await (const chunk of found.content) {
                parts.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
            }
            return Buffer.concat(parts);
        } finally {
            lock.release();
        }
    });
}

/** What a single message's file is called: its subject, or its date when it has
 *  none, which is every automated message ever sent. */
export function emlFilename(subject: string, at: Date): string {
    const named = subject
        .replace(/[^a-zA-Z0-9 ._-]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 60)
        .replace(/\.{2,}/g, ".")
        .replace(/^[.-]+|[.-]+$/g, "");
    return `${named || at.toISOString().slice(0, 10)}.eml`;
}

/** What the export covers. A folder, or the whole mailbox. */
export interface ExportScope {
    readonly accountId: string;
    /** One folder, or null for every folder this mailbox has. */
    readonly folderId: string | null;
}

/**
 * Rebuild one stored message as RFC 822.
 *
 * Deliberately plain: the headers Polaris kept, then the text and the HTML as a
 * two-part alternative when both were downloaded. Not a re-encoding of the
 * original - attachments are not in it, because Polaris does not hold their
 * bytes unless somebody opened them, and a file that silently dropped them
 * while looking complete would be worse than one that says what it is.
 *
 * Pure apart from its arguments, so what an archive actually contains can be
 * asserted without a mail server.
 */
export function rebuildMessage(row: {
    messageId: string;
    inReplyTo: string;
    subject: string;
    fromJson: unknown;
    toJson: unknown;
    ccJson: unknown;
    replyToJson: unknown;
    sentAt: Date;
    bodyText: string | null;
    bodyHtml: string | null;
    snippet: string;
    hasAttachments: boolean;
}): string {
    const people = (value: unknown): string =>
        addressesFrom(value)
            .map((one) => core.addressLabel(one))
            .join(", ");

    const headers: string[] = [
        `Date: ${row.sentAt.toUTCString()}`,
        `From: ${people(row.fromJson)}`,
        `To: ${people(row.toJson)}`
    ];
    const cc = people(row.ccJson);
    if (cc) headers.push(`Cc: ${cc}`);
    const replyTo = people(row.replyToJson);
    if (replyTo) headers.push(`Reply-To: ${replyTo}`);
    headers.push(`Subject: ${row.subject.replace(/[\r\n]+/g, " ")}`);
    if (row.messageId) headers.push(`Message-ID: <${row.messageId.replace(/^<|>$/g, "")}>`);
    if (row.inReplyTo) headers.push(`In-Reply-To: <${row.inReplyTo.replace(/^<|>$/g, "")}>`);
    // Said in the file itself rather than only on the screen that made it: an
    // archive is read years later, by somebody who was not there.
    if (row.hasAttachments) headers.push("X-Polaris-Attachments: not included in this export");
    headers.push("MIME-Version: 1.0");

    const text = row.bodyText ?? "";
    const html = row.bodyHtml ?? "";
    if (html && text) {
        const boundary = `polaris-${Math.abs(hash(row.messageId || row.subject)).toString(36)}`;
        headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
        return [
            headers.join("\n"),
            "",
            `--${boundary}`,
            'Content-Type: text/plain; charset="utf-8"',
            "",
            text,
            `--${boundary}`,
            'Content-Type: text/html; charset="utf-8"',
            "",
            html,
            `--${boundary}--`,
            ""
        ].join("\n");
    }
    headers.push(
        html
            ? 'Content-Type: text/html; charset="utf-8"'
            : 'Content-Type: text/plain; charset="utf-8"'
    );
    // The snippet when nothing was ever downloaded, so a message that was never
    // opened still exports as itself rather than as an empty body.
    return `${headers.join("\n")}\n\n${html || text || row.snippet}\n`;
}

function hash(value: string): number {
    let held = 0;
    for (let index = 0; index < value.length; index += 1)
        held = (held * 31 + value.charCodeAt(index)) | 0;
    return held;
}

/**
 * Every message in scope, as mbox, a page at a time.
 *
 * An async generator rather than a string, so the route can stream it straight
 * to the browser and the whole archive is never in memory at once.
 */
export async function* exportMbox(userId: string, scope: ExportScope): AsyncGenerator<string> {
    // Narrowed by the owner in the query, like every other read here.
    const account = await ownedAccount(userId, scope.accountId);
    let cursor: string | null = null;

    for (;;) {
        const rows: {
            id: string;
            messageId: string;
            inReplyTo: string;
            subject: string;
            fromJson: unknown;
            toJson: unknown;
            ccJson: unknown;
            replyToJson: unknown;
            sentAt: Date;
            bodyText: string | null;
            bodyHtml: string | null;
            snippet: string;
            hasAttachments: boolean;
        }[] = await prisma.mailMessage.findMany({
            where: {
                accountId: account.id,
                ...(scope.folderId ? { folderId: scope.folderId } : {}),
                ...(cursor ? { id: { gt: cursor } } : {})
            },
            orderBy: { id: "asc" },
            take: PAGE,
            select: {
                id: true,
                messageId: true,
                inReplyTo: true,
                subject: true,
                fromJson: true,
                toJson: true,
                ccJson: true,
                replyToJson: true,
                sentAt: true,
                bodyText: true,
                bodyHtml: true,
                snippet: true,
                hasAttachments: true
            }
        });
        if (rows.length === 0) return;

        for (const row of rows) {
            const sender = addressesFrom(row.fromJson)[0]?.address ?? account.address;
            yield core.mboxEntry(rebuildMessage(row), sender, row.sentAt);
        }
        cursor = rows[rows.length - 1]!.id;
        if (rows.length < PAGE) return;
    }
}

/** How many messages an export will carry, so the screen can say so before
 *  somebody starts a download that takes a while. */
export async function exportSize(userId: string, scope: ExportScope): Promise<number> {
    const account = await ownedAccount(userId, scope.accountId);
    return prisma.mailMessage.count({
        where: {
            accountId: account.id,
            ...(scope.folderId ? { folderId: scope.folderId } : {})
        }
    });
}
