/**
 * What has arrived since a tab last asked, for the notice the system draws.
 *
 * The live channel carries which mailbox moved and nothing else - never a
 * subject, never an address - so a tab that wants to say "Ana: Invoice for
 * March" has to ask for it, through the same narrowing every other read here
 * uses. That is this.
 *
 * Only what somebody would want to be interrupted for: unread, in an inbox, not
 * snoozed, not in a conversation they muted, and only on the mailboxes where
 * they left "Notify me" on. And only mail Polaris first saw after the cursor
 * the tab holds - the cursor is the server's clock, handed out by this same
 * call, so a browser whose clock is wrong cannot make a year of mail "new".
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { addressesFrom } from "./json";

/** How many are named, one notice each. Past this it is one notice that says
 *  how many; ten notices at once is a notice nobody reads. */
const NAMED = 3;

/**
 * How old a message may be and still be announced.
 *
 * A folder resynced from scratch writes its rows again, and every row it writes
 * is "first seen" after the cursor. Anything sent more than a day ago is mail
 * the reader has already had the chance to see, whatever the database thinks.
 */
const FRESH_MS = 24 * 60 * 60 * 1000;

export interface MailArrival {
    readonly threadId: string;
    readonly from: string;
    readonly subject: string;
}

export interface MailArrivals {
    /** Hand this back next time. The server's own clock. */
    readonly cursor: string;
    /** The newest few, one notice each. */
    readonly named: readonly MailArrival[];
    /** How many more there are beyond those. */
    readonly more: number;
}

/**
 * Everything new since `since`. With no cursor - a tab's first ask - nothing is
 * announced and a cursor is handed out, so opening a tab never raises a notice
 * about mail that was already there.
 */
export async function arrivalsSince(userId: string, since: Date | null): Promise<MailArrivals> {
    const now = new Date();
    const cursor = now.toISOString();
    if (!since) return { cursor, named: [], more: 0 };

    const where = {
        account: { userId, notify: true },
        createdAt: { gt: since, lte: now },
        sentAt: { gt: new Date(now.getTime() - FRESH_MS) },
        seen: false,
        deleted: false,
        folder: { role: "inbox" },
        thread: { muted: false },
        OR: [{ snoozedUntil: null }, { snoozedUntil: { lte: now } }]
    };
    const [rows, total] = await Promise.all([
        prisma.mailMessage.findMany({
            where,
            select: { threadId: true, subject: true, fromJson: true },
            orderBy: { createdAt: "desc" },
            take: NAMED
        }),
        prisma.mailMessage.count({ where })
    ]);

    return {
        cursor,
        named: rows.map((row) => {
            const sender = addressesFrom(row.fromJson)[0];
            return {
                threadId: row.threadId,
                from: sender ? core.addressLabel(sender) : "Somebody",
                subject: row.subject.trim() || "(no subject)"
            };
        }),
        more: Math.max(0, total - rows.length)
    };
}
