/**
 * The record of what happened to a message after it left.
 *
 * The send queue could never be that record: its entry is deleted the second the
 * message is gone, which is right - it is a queue - and it leaves nothing behind
 * for a bounce arriving on Thursday to be about. So one row is written per
 * message the outgoing server accepted, keyed on the Message-Id, which is the
 * only handle that survives the queue entry going, the Sent copy being filed on
 * somebody else's server, and a resync renumbering everything.
 *
 * The discipline of this module is in what it refuses to say. For a mailbox at
 * somebody else's provider, **accepted means accepted**: the provider took the
 * bytes and has said nothing since. It is not delivered, it is not read, and no
 * screen fed from here may round it up to either. The only thing that ever moves
 * a row off `accepted` is something coming back - a delivery report - which is
 * the one piece of honest evidence a mail client gets.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { addressesFrom, asJson } from "./json";

const BOUNCED_EVENT = "mail.message.bounced";
const UNSENT_EVENT = "mail.message.unsent";
const UNCOPIED_EVENT = "mail.message.uncopied";

/** Whether a copy of what was sent ended up in Sent. */
export type MailSentCopy = "filed" | "automatic" | "none" | "failed";

/** What recording a send needs. */
export interface RecordedSend {
    readonly accountId: string;
    readonly messageId: string;
    readonly subject: string;
    readonly to: readonly core.MailAddress[];
    /** The recipients the outgoing server would not take while taking the rest. */
    readonly refused: readonly string[];
    readonly probe: boolean;
}

/**
 * Write down that a message went.
 *
 * Upserted on the Message-Id, so a send recorded twice - which cannot happen,
 * and would be the worse half of the one bug this whole area exists to avoid -
 * is one row rather than two. Never allowed to throw: the message has gone, and
 * failing here would put its queue entry back and send it a second time.
 */
export async function recordSend(sent: RecordedSend): Promise<string | null> {
    if (!sent.messageId) return null;
    const partial = sent.refused.length > 0;
    try {
        const row = await prisma.mailDelivery.upsert({
            where: { accountId_messageId: { accountId: sent.accountId, messageId: sent.messageId } },
            create: {
                accountId: sent.accountId,
                messageId: sent.messageId,
                subject: sent.subject,
                toJson: asJson(sent.to),
                state: partial ? "partial" : "accepted",
                detail: partial ? core.partialSendSentence(sent.refused) : "",
                detailFor: sent.refused.join(", "),
                probe: sent.probe
            },
            update: {},
            select: { id: true }
        });
        return row.id;
    } catch (caught) {
        console.error("polaris: a sent message could not be recorded:", caught);
        return null;
    }
}

/** Note whether the copy in Sent was filed, and say so once where it was not. */
export async function recordSentCopy(
    deliveryId: string | null,
    accountId: string,
    copy: MailSentCopy
): Promise<void> {
    if (!deliveryId) return;
    try {
        await prisma.mailDelivery.update({ where: { id: deliveryId }, data: { sentCopy: copy } });
        if (copy === "failed") await announceUncopied(accountId, deliveryId);
    } catch (caught) {
        console.error("polaris: a sent message's copy could not be recorded:", caught);
    }
}

/**
 * Say that a message went but its copy did not.
 *
 * Worth saying, because the reader's own record of what they sent is what is
 * missing and nothing else would ever tell them - they would find out by
 * looking for a message they know they wrote. Said at most once a day per
 * mailbox: a Sent folder that cannot be written to fails for every message, and
 * one notice per message would be a bell nobody could clear.
 */
async function announceUncopied(accountId: string, deliveryId: string): Promise<void> {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const already = await prisma.mailDelivery.count({
        where: { accountId, sentCopy: "failed", sentAt: { gte: since }, id: { not: deliveryId } }
    });
    if (already > 0) return;
    const account = await prisma.mailAccount.findUnique({
        where: { id: accountId },
        select: { userId: true, address: true, orgId: true }
    });
    if (!account) return;
    await announce({
        userId: account.userId,
        orgId: account.orgId,
        event: UNCOPIED_EVENT,
        title: `${account.address} is not keeping copies of what you send`,
        body: "Your messages are going out, but the mail server would not file a copy in Sent, so they are not in your own record of them.",
        href: "/mail/settings/accounts",
        metadata: { accountId }
    });
}

/** Say that a message was refused for good, so nothing is waiting on it. */
export async function announceUnsent(
    accountId: string,
    subject: string,
    detail: string
): Promise<void> {
    const account = await prisma.mailAccount.findUnique({
        where: { id: accountId },
        select: { userId: true, address: true, orgId: true }
    });
    if (!account) return;
    await announce({
        userId: account.userId,
        orgId: account.orgId,
        event: UNSENT_EVENT,
        title: `"${subject || "(no subject)"}" was not sent`,
        body: `${detail} It is in Drafts, where you can change it and try again.`,
        href: "/mail/drafts",
        metadata: { accountId }
    });
}

/**
 * Say that a message went to some of the people it was for and not the others.
 *
 * The quietest way to lose mail there is. Submission succeeds when the server
 * took the message for anybody at all, so the message appears in Sent, the
 * composer closes, and the people it was refused for are in a list nobody ever
 * read. The sender has no reason to suspect a thing.
 */
export async function announcePartial(
    accountId: string,
    subject: string,
    detail: string
): Promise<void> {
    const account = await prisma.mailAccount.findUnique({
        where: { id: accountId },
        select: { userId: true, address: true, orgId: true }
    });
    if (!account) return;
    await announce({
        userId: account.userId,
        orgId: account.orgId,
        event: UNSENT_EVENT,
        title: `"${subject || "(no subject)"}" did not go to everybody`,
        body: `${detail} Everyone else was sent it.`,
        href: "/mail",
        metadata: { accountId }
    });
}

/** Say that something sent came back. */
export async function announceBounce(
    accountId: string,
    subject: string,
    detail: string,
    href: string
): Promise<void> {
    const account = await prisma.mailAccount.findUnique({
        where: { id: accountId },
        select: { userId: true, address: true, orgId: true }
    });
    if (!account) return;
    await announce({
        userId: account.userId,
        orgId: account.orgId,
        event: BOUNCED_EVENT,
        title: `"${subject || "(no subject)"}" did not arrive`,
        body: detail,
        href,
        metadata: { accountId }
    });
}

/** One way in to the bell, reached only when there is something to say. The
 *  fan-out is imported here rather than at the top for the reason it is in
 *  `refused`: the send path must not drag every delivery channel in with it. */
async function announce(notice: {
    userId: string;
    orgId: string | null;
    event: string;
    title: string;
    body: string;
    href: string;
    metadata: Record<string, unknown>;
}): Promise<void> {
    try {
        const { notify } = await import("@/lib/notifications/dispatch");
        await notify({
            userId: notice.userId,
            event: notice.event,
            title: notice.title,
            body: notice.body,
            href: notice.href,
            shelf: { orgId: notice.orgId },
            actionRequired: true,
            metadata: notice.metadata
        });
    } catch (caught) {
        // The row already says it and the screens draw that. A bell that could
        // not be written is never worth failing a send or a sweep over.
        console.error("polaris: a delivery notice could not be announced:", caught);
    }
}

/* -------------------------------------------------------------------------- */
/* Reading it back                                                             */
/* -------------------------------------------------------------------------- */

/** What became of one message, for the conversation it is in. */
export interface MailDeliveryView {
    readonly state: "accepted" | "partial" | "delayed" | "bounced";
    /** The reporting server's own words, or "". */
    readonly detail: string;
    /** The address a report was about, or the recipients that were refused. */
    readonly detailFor: string;
    readonly sentCopy: MailSentCopy;
    readonly sentAt: string;
    /** When something came back, or null while nothing has. */
    readonly settledAt: string | null;
    /** The conversation the report arrived in, to open, or "". */
    readonly reportThreadId: string;
}

/**
 * What became of these messages, by Message-Id.
 *
 * One query for a whole conversation. A message with no row is a message Polaris
 * did not send - somebody else's, or one sent from another client - and it gets
 * no state at all rather than an invented one.
 */
export async function deliveriesFor(
    accountIds: readonly string[],
    messageIds: readonly string[]
): Promise<Map<string, MailDeliveryView>> {
    const wanted = [...new Set(messageIds.filter(Boolean))];
    if (wanted.length === 0 || accountIds.length === 0) return new Map();
    const rows = await prisma.mailDelivery.findMany({
        where: { accountId: { in: [...new Set(accountIds)] }, messageId: { in: wanted } },
        select: {
            messageId: true,
            state: true,
            detail: true,
            detailFor: true,
            sentCopy: true,
            sentAt: true,
            settledAt: true,
            reportThreadId: true
        }
    });
    return new Map(
        rows.map((row) => [
            row.messageId,
            {
                state: row.state as MailDeliveryView["state"],
                detail: row.detail,
                detailFor: row.detailFor,
                sentCopy: row.sentCopy as MailSentCopy,
                sentAt: row.sentAt.toISOString(),
                settledAt: row.settledAt?.toISOString() ?? null,
                reportThreadId: row.reportThreadId ?? ""
            }
        ])
    );
}

/** The recipients of a recorded send, for matching a report that names an
 *  address rather than a message. */
export function recipientsOf(toJson: unknown): string[] {
    return addressesFrom(toJson).map((entry) => entry.address.toLowerCase());
}
