/**
 * A mailbox its holder let somebody else read (`mail.mailbox`).
 *
 * The one exception to "a mailbox is reached by being the person who linked
 * it" (`./access`), and it is the holder's own act: nobody else - not an
 * administrator, not whoever runs the organization - can hand it out, because
 * `requireMayShare` asks `ownedAccount` for the person sharing it.
 *
 * **Reading only.** A delegate sees the messages Polaris already holds for the
 * mailbox, newest first, and opens one as plain text. Nothing here sends,
 * replies, moves, flags or marks anything read, and nothing opens a connection
 * to the mail server: what is shown is the copy the holder's own sync already
 * wrote. Sending on somebody's behalf ("send as", "send on behalf of") is a
 * different thing to be trusted with and is deliberately not offered.
 *
 * Every read asks for the grant first and then narrows the mailbox query by
 * `userId: { not: reader }`, so a grant over a row the reader holds themselves
 * is never a second way into it, and a grant whose mailbox was removed reads as
 * no mailbox at all.
 */

import { prisma } from "@polaris/db";
import { addressesFrom } from "./json";
import { MailAccessError } from "./access";
import { grantedCapability, grantedSubjects } from "@/lib/access/grants";

/** How many messages one page of a delegated inbox holds. */
export const DELEGATE_PAGE = 50;

/** What a delegate is told about the mailbox itself: who it is, never how it
 *  connects. */
const DELEGATE_ACCOUNT = { id: true, address: true, label: true, displayName: true } as const;

export interface DelegatedMailbox {
    readonly id: string;
    readonly address: string;
    readonly label: string;
    readonly displayName: string;
}

export interface DelegatedRow {
    readonly id: string;
    readonly subject: string;
    readonly from: string;
    readonly snippet: string;
    readonly sentAt: Date;
    readonly hasAttachments: boolean;
}

export interface DelegatedMessage extends DelegatedRow {
    readonly to: string[];
    readonly cc: string[];
    /** The plain-text body, or null when the holder's sync has not fetched it
     *  yet (the snippet is shown instead). */
    readonly bodyText: string | null;
}

/** Every mailbox somebody let this person read, by address. */
export async function delegatedMailboxes(userId: string): Promise<DelegatedMailbox[]> {
    const lent = [...(await grantedSubjects(userId, "mail.mailbox")).keys()];
    if (lent.length === 0) return [];
    return prisma.mailAccount.findMany({
        where: { id: { in: lent }, userId: { not: userId } },
        select: DELEGATE_ACCOUNT,
        orderBy: [{ address: "asc" }, { id: "asc" }],
        take: lent.length
    });
}

/** One delegated mailbox, if it is still lent to this person. The same refusal
 *  whether it was never lent, was taken back or no longer exists. */
export async function delegatedMailbox(userId: string, accountId: string): Promise<DelegatedMailbox> {
    if (!(await grantedCapability(userId, "mail.mailbox", accountId))) throw new MailAccessError();
    const account = await prisma.mailAccount.findFirst({
        where: { id: accountId, userId: { not: userId } },
        select: DELEGATE_ACCOUNT
    });
    if (!account) throw new MailAccessError();
    return account;
}

function sender(value: unknown): string {
    const first = addressesFrom(value)[0];
    return first ? first.name.trim() || first.address : "";
}

function everyone(value: unknown): string[] {
    return addressesFrom(value).map((entry) =>
        entry.name.trim() ? `${entry.name} <${entry.address}>` : entry.address
    );
}

/**
 * One page of the delegated mailbox's inbox, newest first, from before
 * `before` when given. Drafts and deleted messages are left out.
 */
export async function delegatedInbox(
    userId: string,
    accountId: string,
    before?: Date
): Promise<{ mailbox: DelegatedMailbox; rows: DelegatedRow[]; more: boolean }> {
    const mailbox = await delegatedMailbox(userId, accountId);
    const inbox = await prisma.mailFolder.findFirst({
        where: { accountId, role: "inbox" },
        select: { id: true }
    });
    if (!inbox) return { mailbox, rows: [], more: false };
    const found = await prisma.mailMessage.findMany({
        where: {
            accountId,
            folderId: inbox.id,
            deleted: false,
            draft: false,
            ...(before ? { sentAt: { lt: before } } : {})
        },
        select: {
            id: true,
            subject: true,
            fromJson: true,
            snippet: true,
            sentAt: true,
            hasAttachments: true
        },
        orderBy: [{ sentAt: "desc" }, { id: "desc" }],
        take: DELEGATE_PAGE + 1
    });
    const rows = found.slice(0, DELEGATE_PAGE).map((row) => ({
        id: row.id,
        subject: row.subject,
        from: sender(row.fromJson),
        snippet: row.snippet,
        sentAt: row.sentAt,
        hasAttachments: row.hasAttachments
    }));
    return { mailbox, rows, more: found.length > DELEGATE_PAGE };
}

/** One message of a delegated mailbox, read as plain text. */
export async function delegatedMessage(
    userId: string,
    accountId: string,
    messageId: string
): Promise<DelegatedMessage> {
    await delegatedMailbox(userId, accountId);
    const row = await prisma.mailMessage.findFirst({
        where: { id: messageId, accountId, draft: false },
        select: {
            id: true,
            subject: true,
            fromJson: true,
            toJson: true,
            ccJson: true,
            snippet: true,
            sentAt: true,
            hasAttachments: true,
            bodyText: true
        }
    });
    if (!row) throw new MailAccessError();
    return {
        id: row.id,
        subject: row.subject,
        from: everyone(row.fromJson)[0] ?? "",
        to: everyone(row.toJson),
        cc: everyone(row.ccJson),
        snippet: row.snippet,
        sentAt: row.sentAt,
        hasAttachments: row.hasAttachments,
        bodyText: row.bodyText
    };
}
