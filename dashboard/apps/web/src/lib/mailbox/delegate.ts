/**
 * A mailbox its holder let somebody else read (`mail.mailbox`).
 *
 * The one exception to "a mailbox is reached by being the person who linked
 * it" (`./access`), and it is the holder's own act: nobody else - not an
 * administrator, not whoever runs the organization - can hand it out, because
 * `requireMayShare` asks `ownedAccount` for the person sharing it.
 *
 * **Three levels, as Gmail and Outlook delegation has them.** `view` sees the
 * messages Polaris already holds for the inbox, newest first, and opens one as
 * plain text - nothing is marked read by looking. `respond` also replies and
 * writes from the mailbox's address through its own outgoing server, on the
 * holder's behalf (`Sender:` names the delegate) unless the holder chose "send
 * as". `manage` also marks, stars, archives, files as junk and trashes. What
 * each one does is in `delegate-act`; this file answers who reaches what.
 * Settings, rules, the password and who else it is lent to are never reached:
 * nothing a delegate calls touches them.
 *
 * Every read asks for the grant first and then narrows the mailbox query by
 * `userId: { not: reader }`, so a grant over a row the reader holds themselves
 * is never a second way into it, and a grant whose mailbox was removed reads as
 * no mailbox at all.
 */

import { prisma } from "@polaris/db";
import { addressesFrom } from "./json";
import { MailAccessError } from "./access";
import * as core from "@polaris/core";
import { grantedCapability, grantedSubjects, liveGrants } from "@/lib/access/grants";

/** How many messages one page of a delegated inbox holds. */
export const DELEGATE_PAGE = 50;

/** What a delegate is told about the mailbox itself: who it is, never how it
 *  connects. */
const DELEGATE_ACCOUNT = {
    id: true,
    address: true,
    label: true,
    displayName: true,
    delegateSendAs: true
} as const;

export interface DelegatedMailbox {
    readonly id: string;
    readonly address: string;
    readonly label: string;
    readonly displayName: string;
    /** Whether what a delegate writes goes as this address, with no trace of
     *  them, rather than on its behalf. The holder's choice. */
    readonly delegateSendAs: boolean;
}

/** How far a mailbox is lent: the strongest live grant's word. */
export type DelegateLevel = "view" | "respond" | "manage";

function levelOf(capability: string): DelegateLevel | null {
    return capability === "view" || capability === "respond" || capability === "manage"
        ? capability
        : null;
}

/** Whether `held` reaches `wanted`, on the mailbox's own ladder. What the
 *  screen asks to show a button and what the server asks before doing it. */
export function delegateMay(held: DelegateLevel, wanted: DelegateLevel): boolean {
    return core.atLeast("mail.mailbox", held, wanted);
}

export interface DelegatedRow {
    readonly id: string;
    readonly subject: string;
    readonly from: string;
    readonly snippet: string;
    readonly sentAt: Date;
    readonly hasAttachments: boolean;
    readonly seen: boolean;
    readonly flagged: boolean;
}

export interface DelegatedMessage extends DelegatedRow {
    /** The address a reply goes to: Reply-To where it named one, else From. */
    readonly replyAddress: string;
    readonly to: string[];
    readonly cc: string[];
    /** The plain-text body, or null when the holder's sync has not fetched it
     *  yet (the snippet is shown instead). */
    readonly bodyText: string | null;
}

/** Every mailbox somebody let this person read, by address, with how far. */
export async function delegatedMailboxes(
    userId: string
): Promise<(DelegatedMailbox & { level: DelegateLevel })[]> {
    const held = await grantedSubjects(userId, "mail.mailbox");
    const lent = [...held.keys()];
    if (lent.length === 0) return [];
    const rows = await prisma.mailAccount.findMany({
        where: { id: { in: lent }, userId: { not: userId } },
        select: DELEGATE_ACCOUNT,
        orderBy: [{ address: "asc" }, { id: "asc" }],
        take: lent.length
    });
    return rows.map((row) => ({ ...row, level: levelOf(held.get(row.id) ?? "") ?? "view" }));
}

/** One delegated mailbox, if it is still lent to this person. The same refusal
 *  whether it was never lent, was taken back or no longer exists. */
export async function delegatedMailbox(
    userId: string,
    accountId: string
): Promise<DelegatedMailbox & { level: DelegateLevel }> {
    const level = levelOf(await grantedCapability(userId, "mail.mailbox", accountId));
    if (!level) throw new MailAccessError();
    const account = await prisma.mailAccount.findFirst({
        where: { id: accountId, userId: { not: userId } },
        select: DELEGATE_ACCOUNT
    });
    if (!account) throw new MailAccessError();
    return { ...account, level };
}

/**
 * A lent mailbox, if it is lent to this person at `wanted` or above, with its
 * holder - whose id every mail operation is then run as, since every one of
 * them is narrowed to its holder. The same refusal whatever the reason.
 */
export async function requireDelegate(
    userId: string,
    accountId: string,
    wanted: DelegateLevel
): Promise<{ holderId: string; grantId: string; level: DelegateLevel }> {
    const grants = await liveGrants(userId, "mail.mailbox", accountId);
    const strongest = grants[0];
    const level = strongest ? levelOf(strongest.capability) : null;
    if (!strongest || !level || !delegateMay(level, wanted)) throw new MailAccessError();
    const account = await prisma.mailAccount.findFirst({
        where: { id: accountId, userId: { not: userId } },
        select: { userId: true }
    });
    if (!account) throw new MailAccessError();
    return { holderId: account.userId, grantId: strongest.id, level };
}

/**
 * Who a delegate's message names as its Sender, if the mailbox is still lent
 * to them at `respond` or above - asked when the message goes, so a grant
 * taken back during the undo window stops it. Null otherwise.
 */
export async function delegateSender(
    authorId: string,
    accountId: string
): Promise<{ sender: core.MailAddress; grantId: string } | null> {
    try {
        const { grantId } = await requireDelegate(authorId, accountId, "respond");
        const author = await prisma.user.findUnique({
            where: { id: authorId },
            select: { name: true, email: true }
        });
        if (!author?.email) return null;
        return { sender: { name: author.name, address: author.email }, grantId };
    } catch (caught) {
        if (caught instanceof MailAccessError) return null;
        throw caught;
    }
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

/** Where a page of the delegated inbox resumes: after the last row shown. */
export interface DelegatedCursor {
    readonly sentAt: Date;
    readonly id: string;
}

/** The delegated mailbox's inbox, which is all of it a delegate reads. */
export async function inboxOf(accountId: string): Promise<string | null> {
    const inbox = await prisma.mailFolder.findFirst({
        where: { accountId, role: "inbox" },
        select: { id: true }
    });
    return inbox?.id ?? null;
}

/**
 * One page of the delegated mailbox's inbox, newest first, after `after` when
 * given. Drafts and deleted messages are left out.
 */
export async function delegatedInbox(
    userId: string,
    accountId: string,
    after?: DelegatedCursor
): Promise<{
    mailbox: DelegatedMailbox & { level: DelegateLevel };
    rows: DelegatedRow[];
    more: boolean;
}> {
    const mailbox = await delegatedMailbox(userId, accountId);
    const inboxId = await inboxOf(accountId);
    if (!inboxId) return { mailbox, rows: [], more: false };
    const found = await prisma.mailMessage.findMany({
        where: {
            accountId,
            folderId: inboxId,
            deleted: false,
            draft: false,
            ...(after
                ? {
                      OR: [
                          { sentAt: { lt: after.sentAt } },
                          { sentAt: after.sentAt, id: { lt: after.id } }
                      ]
                  }
                : {})
        },
        select: {
            id: true,
            subject: true,
            fromJson: true,
            snippet: true,
            sentAt: true,
            hasAttachments: true,
            seen: true,
            flagged: true
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
        hasAttachments: row.hasAttachments,
        seen: row.seen,
        flagged: row.flagged
    }));
    return { mailbox, rows, more: found.length > DELEGATE_PAGE };
}

/** One message of a delegated mailbox's inbox, read as plain text. */
export async function delegatedMessage(
    userId: string,
    accountId: string,
    messageId: string
): Promise<DelegatedMessage> {
    await delegatedMailbox(userId, accountId);
    const inboxId = await inboxOf(accountId);
    if (!inboxId) throw new MailAccessError();
    const row = await prisma.mailMessage.findFirst({
        where: { id: messageId, accountId, folderId: inboxId, deleted: false, draft: false },
        select: {
            id: true,
            subject: true,
            fromJson: true,
            toJson: true,
            ccJson: true,
            snippet: true,
            sentAt: true,
            hasAttachments: true,
            seen: true,
            flagged: true,
            replyToJson: true,
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
        seen: row.seen,
        flagged: row.flagged,
        replyAddress:
            addressesFrom(row.replyToJson)[0]?.address ?? addressesFrom(row.fromJson)[0]?.address ?? "",
        bodyText: row.bodyText
    };
}
