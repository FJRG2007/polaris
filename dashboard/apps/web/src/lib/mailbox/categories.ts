/**
 * Sorting mail that arrived before there was anything to sort it with, and
 * clearing up the one kind nobody wants to keep.
 *
 * **The backfill.** A category is decided as a message lands, which does nothing
 * at all for the mail already in a mailbox - and a feature that only sorts what
 * arrives after you turned it on is one that looks broken for a month. So the
 * column starts empty on every existing row and empty means "nothing has decided
 * yet", which makes the column its own queue: a scheduled pass takes a batch of
 * them, decides, writes, and stops finding work once there is none. Nobody is
 * asked to resync a mailbox.
 *
 * Nothing is fetched to do it. The subject, the preview line, the sender and the
 * headers are all already on the row - which is the whole reason the categoriser
 * was written to read only those.
 *
 * **The clearing up.** A verification code stops working in ten minutes and then
 * sits in a mailbox for years. Polaris will throw those away once they are past
 * their use, and it is off by default and per mailbox, because deleting somebody
 * else's mail unasked is not a thing to offer as an opt-out.
 */

import { prisma } from "@polaris/db";
import { publishMail } from "./live";
import * as core from "@polaris/core";
import { addressesFrom } from "./json";
import { actOnMessages } from "./messages";

/**
 * How many messages one pass decides.
 *
 * Large enough that a mailbox of forty thousand is sorted within a few hours of
 * the update that brought this, small enough that the pass is never the reason a
 * database is busy. It runs every minute and stops costing anything the moment
 * there is nothing left with an empty category.
 */
const BATCH = 500;

/** Fill in the category of messages that have none. Answers how many it did, so
 *  the job's own log says whether there is still a backlog. */
export async function backfillCategories(): Promise<number> {
    const rows = await prisma.mailMessage.findMany({
        where: { category: "" },
        select: {
            id: true,
            subject: true,
            snippet: true,
            fromJson: true,
            headers: true
        },
        // Newest first: the mail somebody is most likely to be looking at is
        // sorted before the archive of 2014 is.
        orderBy: { sentAt: "desc" },
        take: BATCH
    });
    if (rows.length === 0) return 0;

    // Grouped by the answer rather than written one at a time: five statements
    // for five hundred messages instead of five hundred.
    const byCategory = new Map<core.MailCategory, string[]>();
    for (const row of rows) {
        const from = addressesFrom(row.fromJson)[0];
        const category = core.categoriseMail({
            subject: row.subject,
            snippet: row.snippet,
            fromAddress: from?.address ?? "",
            fromName: from?.name ?? "",
            headers: (row.headers as Record<string, string> | null) ?? null
        });
        const held = byCategory.get(category);
        if (held) held.push(row.id);
        else byCategory.set(category, [row.id]);
    }

    for (const [category, ids] of byCategory) {
        await prisma.mailMessage.updateMany({ where: { id: { in: ids } }, data: { category } });
    }
    return rows.length;
}

/**
 * Throw away the codes and sign-in links that are past their use.
 *
 * Only for mailboxes whose owner asked, only for messages this deployment
 * decided were codes, and only in the inbox - a code somebody deliberately
 * filed somewhere is one they wanted to keep, and one already in the trash is
 * already gone.
 *
 * It goes through the ordinary trash action rather than deleting rows, so the
 * message lands in the trash on the mail server exactly as it would have if
 * somebody had pressed the button, and it can be taken back out of it.
 *
 * **Only the disposable half of Security.** That tab also holds alerts about an
 * account - a leaked credential, a suspicious sign-in - and those are the
 * opposite kind of message: they do not expire, and they are the most important
 * mail somebody got that week. Sweeping by category would delete them, so each
 * candidate is asked rather than assumed.
 */
export async function sweepExpiredCodes(): Promise<number> {
    const accounts = await prisma.mailAccount.findMany({
        where: { securityKeepMinutes: { gt: 0 }, state: { not: "auth" } },
        select: { id: true, userId: true, securityKeepMinutes: true }
    });
    if (accounts.length === 0) return 0;

    let done = 0;
    for (const account of accounts) {
        const before = new Date(Date.now() - account.securityKeepMinutes * 60_000);
        const stale = await prisma.mailMessage.findMany({
            where: {
                accountId: account.id,
                category: "security",
                receivedAt: { lt: before },
                folder: { role: "inbox" }
            },
            select: { id: true, subject: true, snippet: true },
            take: 200
        });
        // The codes, not the alerts. Read from what the message says rather than
        // from a second column, so a mailbox categorised before this existed is
        // swept correctly without a backfill.
        const disposable = stale.filter((one) =>
            core.isDisposableSecurityMail({
                subject: one.subject,
                snippet: one.snippet,
                fromAddress: "",
                fromName: "",
                headers: null
            })
        );
        if (disposable.length === 0) continue;
        try {
            done += await actOnMessages(
                account.userId,
                disposable.map((one) => one.id),
                "trash"
            );
            publishMail({ accountId: account.id, kind: "messages", actorId: account.userId });
        } catch {
            // A mailbox that is unreachable, or one with nothing holding the
            // trash role - neither is a reason to stop sweeping the others, and
            // the next pass tries again.
        }
    }
    return done;
}
