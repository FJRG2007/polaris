/**
 * What the screens read.
 *
 * Everything here answers one of three questions - what folders are there, what
 * is in this list, what is in this conversation - and every one of them is
 * narrowed by the reader's own id inside the query rather than checked
 * afterwards. There is no `findUnique` followed by an ownership test in this
 * file, on purpose: the two are the same thing until somebody adds a fourth
 * question and forgets the second half.
 *
 * The list is a **window**, the way the chat's message list is. Fifty
 * conversations at a time, cursored on the moment of the newest message, so a
 * mailbox with forty thousand conversations costs the same as one with forty.
 * Reaching the end asks for the next page; it never reaches for all of them.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import type { Prisma } from "@polaris/db";
import { unifiedAccountIds } from "./access";
import { addressesFrom } from "./json";

/** One folder in the rail. */
export interface MailFolderView {
    readonly id: string;
    readonly accountId: string;
    readonly path: string;
    readonly name: string;
    readonly role: core.MailFolderRole;
    readonly unread: number;
    readonly total: number;
    /** How deep it sits under its parent, for the indent. */
    readonly depth: number;
}

/** Every folder worth drawing, ordered the way the rail reads them: the roles
 *  first, in their conventional order, then everything else alphabetically
 *  under its own parent. */
export async function listFolders(userId: string, accountId?: string): Promise<MailFolderView[]> {
    const rows = await prisma.mailFolder.findMany({
        where: {
            account: { userId },
            ...(accountId ? { accountId } : {}),
            hidden: false,
            OR: [{ subscribed: true }, { role: { not: "none" } }]
        },
        select: {
            id: true,
            accountId: true,
            path: true,
            name: true,
            role: true,
            delimiter: true,
            unread: true,
            total: true
        }
    });

    return rows
        .map((row) => ({
            id: row.id,
            accountId: row.accountId,
            path: row.path,
            name: row.name,
            role: row.role as core.MailFolderRole,
            unread: row.unread,
            total: row.total,
            depth: row.delimiter ? Math.max(0, row.path.split(row.delimiter).length - 1) : 0
        }))
        .sort((left, right) => {
            const byRole = core.folderRank(left.role) - core.folderRank(right.role);
            if (byRole !== 0) return byRole;
            return left.path.localeCompare(right.path);
        });
}

/** One row in the conversation list. */
export interface MailThreadView {
    readonly id: string;
    readonly accountId: string;
    readonly subject: string;
    readonly snippet: string;
    readonly participants: readonly core.MailAddress[];
    readonly messageCount: number;
    readonly unreadCount: number;
    readonly starred: boolean;
    readonly pinned: boolean;
    readonly muted: boolean;
    readonly hasAttachments: boolean;
    readonly lastMessageAt: string;
    readonly labels: readonly { id: string; name: string; color: string }[];
    /** The message to open when the row is clicked: the newest one in the
     *  folder being looked at, so opening a conversation from Sent lands on
     *  what was sent rather than on the reply to it. */
    readonly leadMessageId: string;
}

/** What a list is asked for. */
export interface MailListQuery {
    readonly accountId: string | null;
    readonly folderId: string | null;
    /** A role, for the unified views: "inbox" across every mailbox. */
    readonly role: core.MailFolderRole | null;
    readonly labelId: string | null;
    readonly unreadOnly: boolean;
    readonly starredOnly: boolean;
    /** The other side of the snooze filter: only what is still put off, which is
     *  the one screen that exists to show it. */
    readonly snoozedOnly: boolean;
    readonly withAttachments: boolean;
    readonly query: string;
    readonly from: string;
    readonly since: Date | null;
    readonly before: Date | null;
    /** The moment the last row on the previous page was at. */
    readonly cursor: string;
    readonly limit: number;
}

export const EMPTY_QUERY: MailListQuery = {
    accountId: null,
    folderId: null,
    role: null,
    labelId: null,
    unreadOnly: false,
    starredOnly: false,
    snoozedOnly: false,
    withAttachments: false,
    query: "",
    from: "",
    since: null,
    before: null,
    cursor: "",
    limit: 50
};

/**
 * The conversations in a list.
 *
 * Filtered on the messages rather than on the thread wherever the filter is
 * about where a message is: a conversation is in the inbox because a message of
 * it is, and the same conversation is also in Sent. Expressing that as a
 * property of the thread would mean a reply moving the whole conversation out of
 * the inbox, which is not what anybody means by archiving one message.
 */
export async function listThreads(
    userId: string,
    query: MailListQuery
): Promise<{ threads: MailThreadView[]; cursor: string }> {
    // A view that names a mailbox opens that one whatever its switch says; a
    // merged view is only the mailboxes their owner put in it.
    const accountIds = query.accountId ? [query.accountId] : await unifiedAccountIds(userId);
    if (accountIds.length === 0) return { threads: [], cursor: "" };

    const messageWhere: Prisma.MailMessageWhereInput = {
        accountId: { in: accountIds },
        // A snoozed message is not in the list until its hour comes. Never moved
        // to hide it, so it is still in the inbox on somebody's phone. The
        // Snoozed screen is the one place that asks for the other half.
        ...(query.snoozedOnly
            ? { snoozedUntil: { gt: new Date() } }
            : { OR: [{ snoozedUntil: null }, { snoozedUntil: { lte: new Date() } }] }),
        ...(query.folderId ? { folderId: query.folderId } : {}),
        ...(query.role ? { folder: { role: query.role } } : {}),
        ...(query.unreadOnly ? { seen: false } : {}),
        ...(query.starredOnly ? { flagged: true } : {}),
        ...(query.withAttachments ? { hasAttachments: true } : {}),
        ...(query.labelId ? { labels: { some: { labelId: query.labelId } } } : {}),
        ...(query.since || query.before
            ? {
                  sentAt: {
                      ...(query.since ? { gte: query.since } : {}),
                      ...(query.before ? { lte: query.before } : {})
                  }
              }
            : {}),
        ...(query.query
            ? {
                  OR: [
                      { subject: { contains: query.query, mode: "insensitive" } },
                      { snippet: { contains: query.query, mode: "insensitive" } },
                      { bodyText: { contains: query.query, mode: "insensitive" } }
                  ]
              }
            : {}),
        // Matched against the raw JSON, which is what a stored address list is.
        // Good enough for "from: somebody", which is how people search mail, and
        // it needs no second table nobody would otherwise keep in step.
        ...(query.from
            ? { fromJson: { string_contains: query.from.trim().toLowerCase() } }
            : {})
    };

    const cursorAt = query.cursor ? new Date(query.cursor) : null;
    const threads = await prisma.mailThread.findMany({
        where: {
            accountId: { in: accountIds },
            messages: { some: messageWhere },
            ...(cursorAt ? { lastMessageAt: { lt: cursorAt } } : {})
        },
        select: {
            id: true,
            accountId: true,
            subject: true,
            snippet: true,
            participants: true,
            messageCount: true,
            unreadCount: true,
            starred: true,
            pinned: true,
            muted: true,
            hasAttachments: true,
            lastMessageAt: true,
            messages: {
                where: messageWhere,
                select: { id: true, labels: { select: { label: true } } },
                orderBy: { sentAt: "desc" },
                take: 1
            }
        },
        orderBy: [{ pinned: "desc" }, { lastMessageAt: "desc" }],
        take: query.limit
    });

    const rows = threads.map((thread) => ({
        id: thread.id,
        accountId: thread.accountId,
        subject: thread.subject,
        snippet: thread.snippet,
        participants: addressesFrom(thread.participants),
        messageCount: thread.messageCount,
        unreadCount: thread.unreadCount,
        starred: thread.starred,
        pinned: thread.pinned,
        muted: thread.muted,
        hasAttachments: thread.hasAttachments,
        lastMessageAt: thread.lastMessageAt.toISOString(),
        labels: (thread.messages[0]?.labels ?? []).map((applied) => ({
            id: applied.label.id,
            name: applied.label.name,
            color: applied.label.color
        })),
        leadMessageId: thread.messages[0]?.id ?? ""
    }));

    // The cursor is the oldest row's moment. Pinned rows sort first and are few,
    // so a page that is all pins would otherwise cursor on a date newer than the
    // page below it; taking the smallest of the page rather than its last row is
    // what stops that skipping conversations.
    const oldest = rows.reduce<string>(
        (low, row) => (low === "" || row.lastMessageAt < low ? row.lastMessageAt : low),
        ""
    );
    return { threads: rows, cursor: rows.length < query.limit ? "" : oldest };
}

/** One message in a conversation, as the reading pane lists it. */
export interface MailMessageView {
    readonly id: string;
    readonly accountId: string;
    readonly folderId: string;
    readonly folderRole: core.MailFolderRole;
    readonly subject: string;
    readonly from: readonly core.MailAddress[];
    readonly to: readonly core.MailAddress[];
    readonly cc: readonly core.MailAddress[];
    readonly replyTo: readonly core.MailAddress[];
    readonly snippet: string;
    readonly sentAt: string;
    readonly seen: boolean;
    readonly flagged: boolean;
    readonly answered: boolean;
    readonly wantsReceipt: boolean;
    readonly listId: string;
    readonly attachments: readonly {
        id: string;
        name: string;
        contentType: string;
        size: number;
        inline: boolean;
        contentId: string;
    }[];
}

/** Every message in one conversation, oldest first, as long as the conversation
 *  is on one of this person's mailboxes. */
export async function readThread(userId: string, threadId: string): Promise<MailMessageView[]> {
    const messages = await prisma.mailMessage.findMany({
        where: { threadId, account: { userId } },
        select: {
            id: true,
            accountId: true,
            folderId: true,
            subject: true,
            fromJson: true,
            toJson: true,
            ccJson: true,
            replyToJson: true,
            snippet: true,
            sentAt: true,
            seen: true,
            flagged: true,
            answered: true,
            wantsReceipt: true,
            listId: true,
            folder: { select: { role: true } },
            attachments: {
                select: {
                    id: true,
                    name: true,
                    contentType: true,
                    size: true,
                    inline: true,
                    contentId: true
                }
            }
        },
        orderBy: { sentAt: "asc" }
    });

    return messages.map((message) => ({
        id: message.id,
        accountId: message.accountId,
        folderId: message.folderId,
        folderRole: message.folder.role as core.MailFolderRole,
        subject: message.subject,
        from: addressesFrom(message.fromJson),
        to: addressesFrom(message.toJson),
        cc: addressesFrom(message.ccJson),
        replyTo: addressesFrom(message.replyToJson),
        snippet: message.snippet,
        sentAt: message.sentAt.toISOString(),
        seen: message.seen,
        flagged: message.flagged,
        answered: message.answered,
        wantsReceipt: message.wantsReceipt,
        listId: message.listId,
        attachments: message.attachments.map((file) => ({
            id: file.id,
            name: file.name,
            contentType: file.contentType,
            size: Number(file.size),
            inline: file.inline,
            contentId: file.contentId
        }))
    }));
}

/** How many unread messages are waiting, per mailbox and in total, for the badge
 *  on the app switcher and the number beside each account. */
export async function unreadCounts(
    userId: string
): Promise<{ total: number; byAccount: Record<string, number> }> {
    const rows = await prisma.mailMessage.groupBy({
        by: ["accountId"],
        where: {
            account: { userId },
            folder: { role: "inbox" },
            seen: false,
            OR: [{ snoozedUntil: null }, { snoozedUntil: { lte: new Date() } }]
        },
        _count: { _all: true }
    });
    const byAccount: Record<string, number> = {};
    let total = 0;
    for (const row of rows) {
        byAccount[row.accountId] = row._count._all;
        total += row._count._all;
    }
    return { total, byAccount };
}
