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

import Fuse from "fuse.js";
import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { addressesFrom } from "./json";
import type { Prisma } from "@polaris/db";
import { unifiedAccountIds } from "./access";
import { mailCursorOf, mailCursorWhere, mailOrderBy } from "./list-order";

/** One folder in the rail. */
export interface MailFolderView {
    readonly id: string;
    readonly accountId: string;
    readonly path: string;
    readonly name: string;
    readonly role: core.MailFolderRole;
    readonly unread: number;
    readonly total: number;
    /** A colour its owner gave it, or "". Polaris' own: IMAP has none. */
    readonly color: string;
    /** How deep it sits under its parent, for the indent. */
    readonly depth: number;
}

/**
 * Every folder worth drawing, ordered the way the rail reads them: the roles
 * first, in their conventional order, then everything else alphabetically under
 * its own parent.
 *
 * Narrowed to the shelf being worked from, like every other lister here: Mail
 * draws somebody's own mailboxes or an organization's, never the two in one
 * rail, and a screen handed both silently shows the wrong working life.
 */
export async function listFolders(
    userId: string,
    shelfOrgId: string | null,
    accountId?: string
): Promise<MailFolderView[]> {
    const rows = await prisma.mailFolder.findMany({
        where: {
            account: { userId, orgId: shelfOrgId },
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
            total: true,
            color: true
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
            color: row.color,
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
    /** Whether any message in it is marked important. */
    readonly important: boolean;
    readonly pinned: boolean;
    readonly muted: boolean;
    readonly hasAttachments: boolean;
    /** Everything in it, in bytes: what the size orders read, and what the row
     *  shows when it is being read that way. */
    readonly size: number;
    readonly lastMessageAt: string;
    /** Where this list lets somebody off it, or "". Read from the newest
     *  message's headers, which are already stored - the body is not, until
     *  somebody opens it, so the reading pane finds the ones that only say it in
     *  their footer. */
    readonly unsubscribe: string;
    /** Which of the three ways out it is, so the row acts rather than only
     *  linking: a sender publishing RFC 8058 one-click is left without opening
     *  anything. "" alongside an empty `unsubscribe`. */
    readonly unsubscribeKind: core.UnsubscribeOffer["kind"] | "";
    /** Whether the sender published it or Polaris read it out of the message.
     *  A header is a promise; a body is a guess, and the screen says so before
     *  it does anything from this mailbox on the strength of it. */
    readonly unsubscribeSource: core.UnsubscribeOffer["source"] | "";
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
    /** The other half of the same switch. Not the absence of `unreadOnly`: a
     *  list with neither on it is the whole list, which is what most of them
     *  are. */
    readonly readOnly: boolean;
    readonly starredOnly: boolean;
    /** Only what somebody marked important, across every mailbox. */
    readonly importantOnly: boolean;
    /** The other side of the snooze filter: only what is still put off, which is
     *  the one screen that exists to show it. */
    readonly snoozedOnly: boolean;
    readonly withAttachments: boolean;
    /** One of the tabs above the list, or "" for all of them. */
    readonly category: string;
    readonly query: string;
    readonly from: string;
    readonly since: Date | null;
    readonly before: Date | null;
    /** Which way round the list is read. */
    readonly sort: core.MailSort;
    /** Where the previous page ended, in whatever shape that order pages by. */
    readonly cursor: string;
    readonly limit: number;
}

export const EMPTY_QUERY: MailListQuery = {
    accountId: null,
    folderId: null,
    role: null,
    labelId: null,
    unreadOnly: false,
    readOnly: false,
    starredOnly: false,
    importantOnly: false,
    snoozedOnly: false,
    withAttachments: false,
    category: "",
    query: "",
    from: "",
    since: null,
    before: null,
    sort: core.DEFAULT_MAIL_SORT,
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
    query: MailListQuery,
    /** The shelf being worked from - null for their own mailboxes, an
     *  organization's id for its work. A separate argument rather than a field
     *  on the query, because the query is built from the address bar and the
     *  shelf never is. */
    shelfOrgId: string | null
): Promise<{ threads: MailThreadView[]; cursor: string }> {
    // A view that names a mailbox opens that one whatever its switch says; a
    // merged view is only the mailboxes their owner put in it, on this shelf.
    const accountIds = query.accountId
        ? [query.accountId]
        : await unifiedAccountIds(userId, shelfOrgId);
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
        ...(query.importantOnly ? { important: true } : {}),
        ...(query.withAttachments ? { hasAttachments: true } : {}),
        ...(query.category ? { category: query.category } : {}),
        ...(query.labelId ? { labels: { some: { labelId: query.labelId } } } : {}),
        ...(query.since || query.before
            ? {
                  sentAt: {
                      ...(query.since ? { gte: query.since } : {}),
                      ...(query.before ? { lte: query.before } : {})
                  }
              }
            : {}),
        // The search itself is not here. Who a message is from and to is stored
        // as JSON, which the database cannot be asked about usefully - which is
        // why searching for the sender's own address found nothing at all. It is
        // answered in `matchingThreads` instead, over a bounded window.
        ...(query.from ? { fromJson: { string_contains: query.from.trim().toLowerCase() } } : {})
    };

    // Which conversations the search admits, decided before the list is drawn so
    // the page, the cursor and the order below are the ordinary ones.
    const terms = query.query.trim() ? core.parseMailSearch(query.query) : core.EMPTY_SEARCH;
    const matched = core.searchIsEmpty(terms)
        ? null
        : await matchingThreads(accountIds, query, terms);
    if (matched && matched.size === 0) return { threads: [], cursor: "" };

    const threads = await prisma.mailThread.findMany({
        where: {
            accountId: { in: accountIds },
            messages: { some: messageWhere },
            // Read is a fact about the conversation and not about a message in
            // it. Asked the other way round - "has a message that was read" - it
            // matches the moment somebody opens the first of five, so the same
            // conversation sits in both the Unread list and the Read one and the
            // Read one is very nearly the whole mailbox. The count is already
            // held on the row, so the question has an exact answer.
            ...(query.readOnly ? { unreadCount: 0 } : {}),
            ...(matched ? { id: { in: [...matched] } } : {}),
            ...mailCursorWhere(query.sort, query.cursor)
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
            important: true,
            pinned: true,
            muted: true,
            hasAttachments: true,
            size: true,
            lastMessageAt: true,
            messages: {
                where: messageWhere,
                select: { id: true, headers: true, labels: { select: { label: true } } },
                orderBy: { sentAt: "desc" },
                take: 1
            }
        },
        orderBy: mailOrderBy(query.sort),
        take: query.limit
    });

    const rows: MailThreadView[] = threads.map((thread) => {
        const offer = offerOf(thread.messages[0]?.headers);
        return {
            id: thread.id,
            accountId: thread.accountId,
            subject: thread.subject,
            // Tidied on the way out, not only on the way in. A mailbox synced before
            // the preview function existed holds rows that read `Mar=C3=ADa` and
            // carry a stylesheet in them, and nobody is going to be told to resync a
            // mailbox to stop looking at that. Running it again over a line that is
            // already clean changes nothing.
            snippet: core.snippetFrom(thread.snippet),
            participants: addressesFrom(thread.participants),
            messageCount: thread.messageCount,
            unreadCount: thread.unreadCount,
            starred: thread.starred,
            important: thread.important,
            pinned: thread.pinned,
            muted: thread.muted,
            hasAttachments: thread.hasAttachments,
            size: thread.size,
            lastMessageAt: thread.lastMessageAt.toISOString(),
            unsubscribe: offer?.url ?? "",
            unsubscribeKind: offer?.kind ?? "",
            unsubscribeSource: offer?.source ?? "",
            labels: (thread.messages[0]?.labels ?? []).map((applied) => ({
                id: applied.label.id,
                name: applied.label.name,
                color: applied.label.color
            })),
            leadMessageId: thread.messages[0]?.id ?? ""
        };
    });

    // Where the next page starts, in whatever shape this order pages by. The
    // reasoning - and the reason it is the page's edge rather than its last row -
    // is in `list-order`, where it can be tested.
    return { threads: rows, cursor: mailCursorOf(query.sort, rows, query.limit) };
}

/** The way out the newest message in a conversation publishes, read off the
 *  headers already stored. The body is not read here: it is not held until
 *  somebody opens the message, and the reading pane looks there itself. */
function offerOf(headers: unknown): core.UnsubscribeOffer | null {
    return core.unsubscribeFromHeaders((headers as Record<string, string> | null) ?? null);
}

/**
 * How much mail one search reads before it answers.
 *
 * A ceiling rather than a page: the words and the people are matched here rather
 * than in the database, so this is the honest cost of a search and it has to be
 * bounded. High enough that a year of one mailbox is inside it, low enough that
 * the worst search anybody can type is a few hundred milliseconds.
 */
const SEARCH_WINDOW = 2000;

/**
 * The conversations a search admits.
 *
 * Split in two on purpose, along the line of what a database is good at. The
 * flags, the folder and the dates are columns with indexes on them, so they
 * narrow the window before anything is read. Who a message is from and to is
 * JSON in a column - a shape no index helps with, and the reason searching for
 * the sender's own address used to find nothing - so those, the phrases, the
 * exclusions and the loose words are answered over what comes back.
 *
 * The loose words go through Fuse, which is what makes a search forgiving: a
 * half-remembered name, a subject typed from memory, an address with one letter
 * wrong. Everything with an operator on it stays exact, because somebody who
 * wrote `from:ana` meant Ana.
 */
async function matchingThreads(
    accountIds: string[],
    query: MailListQuery,
    terms: core.MailSearchTerms
): Promise<Set<string>> {
    const messages = await prisma.mailMessage.findMany({
        where: {
            accountId: { in: accountIds },
            ...(query.folderId ? { folderId: query.folderId } : {}),
            ...(query.role ? { folder: { role: query.role } } : {}),
            ...(query.labelId ? { labels: { some: { labelId: query.labelId } } } : {}),
            ...(query.category ? { category: query.category } : {}),
            ...(terms.hasAttachment || query.withAttachments ? { hasAttachments: true } : {}),
            ...(query.unreadOnly ? { seen: false } : {}),
            ...(query.starredOnly ? { flagged: true } : {}),
            ...(query.importantOnly ? { important: true } : {}),
            ...(terms.unread === null ? {} : { seen: !terms.unread }),
            ...(terms.starred === null ? {} : { flagged: terms.starred }),
            ...(terms.after || terms.before
                ? {
                      sentAt: {
                          ...(terms.after ? { gte: new Date(`${terms.after}T00:00:00`) } : {}),
                          ...(terms.before ? { lte: new Date(`${terms.before}T23:59:59.999`) } : {})
                      }
                  }
                : {})
        },
        select: {
            threadId: true,
            subject: true,
            snippet: true,
            bodyText: true,
            fromJson: true,
            toJson: true,
            ccJson: true,
            hasAttachments: true,
            seen: true,
            flagged: true,
            sentAt: true
        },
        orderBy: { sentAt: "desc" },
        take: SEARCH_WINDOW
    });

    const searchable = messages.map((message) => ({
        threadId: message.threadId,
        subject: message.subject,
        snippet: core.snippetFrom(message.snippet),
        // Only what has been fetched. Most rows have no body until somebody opens
        // them, which is why the empty state says the search covers what Polaris
        // holds rather than the whole mailbox.
        body: message.bodyText ?? "",
        from: named(message.fromJson),
        to: named(message.toJson),
        cc: named(message.ccJson),
        hasAttachments: message.hasAttachments,
        seen: message.seen,
        flagged: message.flagged,
        sentAt: message.sentAt
    }));

    const exact = searchable.filter((message) => core.mailSearchAdmits(message, terms));
    if (!terms.text) return new Set(exact.map((message) => message.threadId));

    const fuse = new Fuse(exact, {
        includeScore: false,
        ignoreLocation: true,
        threshold: 0.35,
        minMatchCharLength: 2,
        keys: [
            { name: "subject", weight: 0.4 },
            // One field rather than three, so a name in the To line scores the
            // same as the same name in the From line - which is what somebody
            // typing a colleague's name into the box means.
            {
                name: "people",
                weight: 0.3,
                getFn: (message) => [...message.from, ...message.to, ...message.cc]
            },
            { name: "snippet", weight: 0.2 },
            { name: "body", weight: 0.1 }
        ]
    });
    return new Set(fuse.search(terms.text).map((hit) => hit.item.threadId));
}

/** An address list as words a search can match: the name and the address of each
 *  person on the message, because people search for both. */
function named(value: unknown): string[] {
    return addressesFrom(value).flatMap((entry) =>
        entry.name.trim() ? [entry.name, entry.address] : [entry.address]
    );
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
    readonly important: boolean;
    readonly answered: boolean;
    readonly wantsReceipt: boolean;
    readonly listId: string;
    /** What Polaris' own junk filter made of it, 0 to 100, or null for a message
     *  nothing judged. Shown rather than acted on here: the acting happened when
     *  it arrived. */
    readonly spamScore: number | null;
    /** The heaviest thing said against it, in the reader's words, or "". */
    readonly spamReason: string;
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
            important: true,
            answered: true,
            wantsReceipt: true,
            listId: true,
            spamScore: true,
            spamReason: true,
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
        snippet: core.snippetFrom(message.snippet),
        sentAt: message.sentAt.toISOString(),
        seen: message.seen,
        flagged: message.flagged,
        important: message.important,
        answered: message.answered,
        wantsReceipt: message.wantsReceipt,
        listId: message.listId,
        spamScore: message.spamScore,
        spamReason: message.spamReason,
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

/**
 * One conversation, with a row to head it, whether or not it is in any list.
 *
 * A link to a conversation is a link somebody was sent, and it has to open even
 * when the list beside it has moved on - archived, trashed, or simply older than
 * the page being looked at. So the row is built from the conversation's own
 * messages rather than found in a list, which is also what makes it right after
 * an action has dropped the row from under the reader.
 *
 * Nothing here decides who may see it: `readThread` narrows by the reader, so an
 * empty answer is both "there is no such conversation" and "it is not yours",
 * and the caller cannot tell the two apart. That is deliberate.
 */
export async function readThreadView(
    userId: string,
    threadId: string
): Promise<{ thread: MailThreadView | null; messages: MailMessageView[] }> {
    const messages = await readThread(userId, threadId);
    if (messages.length === 0) return { thread: null, messages: [] };
    // Pinned and muted are the conversation's own and nothing on a message says
    // them, so they are read off its row - narrowed by the reader like the rest.
    // Hardcoded off, a pinned conversation opened from a link offered to pin it.
    const state = await prisma.mailThread.findFirst({
        where: { id: threadId, account: { userId } },
        select: { pinned: true, muted: true }
    });

    const first = messages[0]!;
    const newest = messages.at(-1)!;
    return {
        thread: {
            id: threadId,
            accountId: first.accountId,
            subject: first.subject,
            snippet: first.snippet,
            participants: first.from,
            messageCount: messages.length,
            unreadCount: messages.filter((message) => !message.seen).length,
            starred: messages.some((message) => message.flagged),
            important: messages.some((message) => message.important),
            pinned: state?.pinned ?? false,
            muted: state?.muted ?? false,
            hasAttachments: messages.some((message) => message.attachments.length > 0),
            // Not read: this one is built from its own messages rather than from
            // a list, and their sizes are not part of that shape. It is only ever
            // drawn as the conversation being read, where nothing shows a size.
            size: 0,
            lastMessageAt: newest.sentAt,
            unsubscribe: "",
            unsubscribeKind: "",
            unsubscribeSource: "",
            labels: [],
            leadMessageId: newest.id
        },
        messages
    };
}

/** Every shelf at once, for the badges outside Mail: a message arriving in a
 *  company mailbox is one somebody wants to be told about whichever shelf they
 *  happen to be looking at. Named so that asking for it is a decision. */
export const EVERY_SHELF = "every" as const;

/**
 * How many unread messages are waiting, per mailbox and in total, for the badge
 * on the app switcher and the number beside each account.
 *
 * The shelf has to be written down. Mail's own rail asks for the one it is
 * drawing, or its total counts mailboxes that are not on the screen and quietly
 * disagrees with the numbers beside them.
 */
export async function unreadCounts(
    userId: string,
    shelfOrgId: string | null | typeof EVERY_SHELF
): Promise<{ total: number; byAccount: Record<string, number> }> {
    const rows = await prisma.mailMessage.groupBy({
        by: ["accountId"],
        where: {
            account: { userId, ...(shelfOrgId === EVERY_SHELF ? {} : { orgId: shelfOrgId }) },
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
