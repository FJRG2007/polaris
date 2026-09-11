/**
 * Reading a message, and doing something to it.
 *
 * Two rules run through the whole file.
 *
 * **The server is told first, and the cache follows.** Every action here writes
 * to IMAP and only then updates the row. Doing it the other way round gives an
 * interface that lies: a message that looks archived here and is still in the
 * inbox on the phone, with nothing on screen to say the server refused. The
 * screens get their instant feedback from optimistic UI in the browser, which
 * rolls back when the action comes back refused - which is the honest version
 * of the same speed.
 *
 * **Actions are expressed as roles, never as paths.** "Archive" is "put it in
 * whatever this server calls Archive", so a mailbox whose folders are in German
 * behaves exactly like one whose are not, and a server with no Archive folder is
 * told to make one rather than silently doing nothing.
 */

import { teachSpam } from "./spam";
import { after } from "next/server";
import { prisma } from "@polaris/db";
import { publishMail } from "./live";
import * as core from "@polaris/core";
import { addressesFrom } from "./json";
import { readShape } from "./structure";
import type { ImapFlow } from "imapflow";
import { decodePart, unflow } from "./decode";
import { folderForRole } from "./folder-roles";
import { recordSubscription } from "./subscriptions";
import { catchUpFolder, refreshThreads } from "./sync";
import { withImap, type MailConnectionSource } from "./imap";
import { addDelta, nudgeFolderUnread, unseenByFolder } from "./folder-counts";
import {
    ACCOUNT_COLUMNS,
    MailAccessError,
    ownedAccount,
    ownedMessages,
    ownedThreadMessages
} from "./access";

/** What a message action is asked for as. */
export type MailAction =
    | "read"
    | "unread"
    | "star"
    | "unstar"
    | "important"
    | "unimportant"
    | "archive"
    | "trash"
    | "delete"
    | "junk"
    | "not-junk"
    | "inbox";

/**
 * The keyword Important is written as.
 *
 * A folder that does not store keywords is simply not told - imapflow leaves out
 * any flag a folder's PERMANENTFLAGS refuses - and the mark stays here, which is
 * why sync never reads its absence as a "no" until the folder is known to keep
 * keywords (`MailFolder.keywords`).
 */
const IMPORTANT_KEYWORD = core.MAIL_IMPORTANT_KEYWORD;

/** The flag an action sets, for the ones that are flags rather than moves. */
const FLAG_ACTIONS: Partial<
    Record<MailAction, { flag: string; add: boolean; column: "seen" | "flagged" | "important" }>
> = {
    read: { flag: "\\Seen", add: true, column: "seen" },
    unread: { flag: "\\Seen", add: false, column: "seen" },
    star: { flag: "\\Flagged", add: true, column: "flagged" },
    unstar: { flag: "\\Flagged", add: false, column: "flagged" },
    important: { flag: IMPORTANT_KEYWORD, add: true, column: "important" },
    unimportant: { flag: IMPORTANT_KEYWORD, add: false, column: "important" }
};

/** Whether the folder open on this connection stores `$Important`: either any
 *  keyword (`\*`) or that one by name, in its permanent flags. */
export function keepsKeyword(client: ImapFlow): boolean {
    const mailbox = client.mailbox;
    if (!mailbox || typeof mailbox === "boolean") return false;
    const permanent = mailbox.permanentFlags;
    return Boolean(permanent && (permanent.has("\\*") || permanent.has(IMPORTANT_KEYWORD)));
}

/**
 * Pin or mute the conversations a set of messages belong to.
 *
 * Neither is a thing a mail server has a word for, so nothing is sent to one:
 * these are columns on Polaris' own conversation row, narrowed by the reader's
 * id inside the query that resolves them. A pinned conversation sits at the top
 * of every list it is in (`list-order`); a muted one is never announced, which
 * is what the new-mail notice reads.
 */
export async function setConversationState(
    userId: string,
    messageIds: readonly string[],
    state: { pinned?: boolean; muted?: boolean }
): Promise<number> {
    const messages = await prisma.mailMessage.findMany({
        where: { id: { in: [...messageIds] }, account: { userId } },
        select: { threadId: true, accountId: true }
    });
    if (messages.length === 0) return 0;
    const threadIds = [...new Set(messages.map((message) => message.threadId))];
    const data: { pinned?: boolean; muted?: boolean } = {};
    if (state.pinned !== undefined) data.pinned = state.pinned;
    if (state.muted !== undefined) data.muted = state.muted;
    const { count } = await prisma.mailThread.updateMany({
        where: { id: { in: threadIds }, account: { userId } },
        data
    });
    for (const accountId of new Set(messages.map((message) => message.accountId))) {
        publishMail({ accountId, kind: "messages", actorId: userId });
    }
    return count;
}

/** Where each moving action puts a message. */
const MOVE_ACTIONS: Partial<Record<MailAction, core.MailFolderRole>> = {
    archive: "archive",
    trash: "trash",
    junk: "junk",
    "not-junk": "inbox",
    inbox: "inbox"
};

/**
 * Raised when an action needs a folder this mailbox has no equivalent of, and
 * the folder with a role.
 *
 * Both live in `folder-roles` now, because the junk filter needs the same answer
 * and this module calls the junk filter - so the question had to move somewhere
 * neither end of that owns. Re-exported here because the actions catch the error
 * by name and it is the same error.
 *
 * The rule behind it has not changed and is worth keeping written down: it used
 * to create the folder. That was wrong, and somebody found out the way people
 * find these things out - a mailbox whose trash is called `Papelera` ended up
 * with a second, empty `Trash` that Polaris had written into their mail server,
 * and which they then saw in every other client they own. Making a folder in
 * somebody else's mailbox is not a default, whatever the convenience.
 */
export { MailFolderRoleMissing } from "./folder-roles";

/**
 * Say which folder is this mailbox's Trash, Archive or Junk.
 *
 * The answer sticks: `roleLocked` keeps the next sync from reading the role off
 * the server again. Any other folder that was holding the role by a name match
 * loses it, so the mailbox has exactly one of each.
 */
export async function setFolderRole(
    userId: string,
    folderId: string,
    role: core.MailFolderRole
): Promise<void> {
    const folder = await prisma.mailFolder.findFirst({
        where: { id: folderId, account: { userId } },
        select: { id: true, accountId: true }
    });
    if (!folder) throw new MailAccessError("That folder is not yours.");
    await prisma.$transaction([
        prisma.mailFolder.updateMany({
            where: { accountId: folder.accountId, role, id: { not: folder.id } },
            data: { role: "none", roleLocked: false }
        }),
        prisma.mailFolder.update({ where: { id: folder.id }, data: { role, roleLocked: true } })
    ]);
}

/**
 * Give a folder a colour, or take one off.
 *
 * Polaris' own and nothing to do with the mail server: IMAP has no notion of a
 * folder's colour, so this is a column here and a resync leaves it alone.
 *
 * Worth having because folders are how people actually file mail, and a rail of
 * twenty identical grey rows is one nobody scans - the two or three that matter
 * are the ones worth being able to find without reading.
 */
export async function setFolderColor(
    userId: string,
    folderId: string,
    color: string
): Promise<void> {
    const folder = await prisma.mailFolder.findFirst({
        where: { id: folderId, account: { userId } },
        select: { id: true }
    });
    if (!folder) throw new MailAccessError("That folder is not yours.");
    const wanted = /^#[0-9a-fA-F]{6}$/.test(color.trim()) ? color.trim().toLowerCase() : "";
    await prisma.mailFolder.update({ where: { id: folder.id }, data: { color: wanted } });
}

/**
 * Make a folder for a role, because its owner asked for one.
 *
 * The only path that writes a folder into somebody else's mailbox, and it is
 * reached from a button that says so. The English name is used because that is
 * what the SPECIAL-USE flag attaches to, so every other client will recognise it.
 */
export async function createFolderForRole(
    userId: string,
    accountId: string,
    role: core.MailFolderRole
): Promise<string> {
    const account = await ownedAccount(userId, accountId);
    const name =
        role === "archive"
            ? "Archive"
            : role === "junk"
              ? "Junk"
              : role === "trash"
                ? "Trash"
                : "Archive";
    await withImap(account, async (client) => {
        await client.mailboxCreate(name).catch(() => undefined);
        await client.mailboxSubscribe(name).catch(() => undefined);
    });
    const created = await prisma.mailFolder.upsert({
        where: { accountId_path: { accountId, path: name } },
        update: { role, roleLocked: true, subscribed: true },
        create: { accountId, path: name, name, role, roleLocked: true, subscribed: true },
        select: { id: true }
    });
    publishMail({ accountId, kind: "folders", actorId: userId });
    return created.id;
}

/** Group a set of messages by the folder they are in, because every IMAP command
 *  acts on one open folder. */
function byFolder<T extends { folderId: string }>(rows: readonly T[]): Map<string, T[]> {
    const out = new Map<string, T[]>();
    for (const row of rows) {
        const held = out.get(row.folderId);
        if (held) held.push(row);
        else out.set(row.folderId, [row]);
    }
    return out;
}

/** What a caller can vary about an action. */
export interface MailActionOptions {
    /**
     * Whether Junk and Not junk also teach the filter. True everywhere a person
     * pressed the button, and false for the filter's own verdict: a classifier
     * trained on its own output converges on believing whatever it happened to
     * think first.
     */
    readonly teach?: boolean;
    /**
     * Whether the tidying that follows a move is done here: reading the folder
     * the messages landed in, and rebuilding this mailbox's conversations.
     *
     * True for anything somebody is watching, because they will look there.
     * False for the junk filter, which runs inside a sync that does both itself
     * once the folder is through - a connection per arriving message is how an
     * account reaches its server's concurrent-connection limit, and rebuilding
     * five hundred conversations per message is the sync taking minutes.
     */
    readonly settle?: boolean;
    /**
     * What the messages named stand for.
     *
     * `message` is the literal set. `conversation` means they were named by a
     * screen that lists conversations - a row in the list, the header of the
     * pane - and the action is meant for everything in them.
     *
     * Honoured for Read and Unread alone, and deliberately not for a move: a
     * conversation lives in several folders at once, and archiving "the
     * conversation" would be a promise about mail the screen is not showing.
     * Read is the opposite - a conversation with one message left unread is a
     * row that stays bold after somebody read it, which is the mark not working.
     */
    readonly scope?: "message" | "conversation";
}

/**
 * Do one thing to a set of messages.
 *
 * The set can span folders and accounts, because a unified inbox is a list of
 * messages from several mailboxes and selecting six of them and pressing archive
 * has to work. One connection per account, one open folder per group.
 */
export async function actOnMessages(
    userId: string,
    messageIds: readonly string[],
    action: MailAction,
    options: MailActionOptions = {}
): Promise<number> {
    const messages = await ownedMessages(userId, messageIds);
    if (messages.length === 0) return 0;

    // A flag is not a move, and it used to be treated as one.
    const flag = FLAG_ACTIONS[action];
    if (flag) {
        // Aimed at conversations rather than at messages - see `scope`. The
        // messages named are the screen's handle on them, and what has to change
        // is everything in them.
        const whole =
            options.scope === "conversation" && (action === "read" || action === "unread")
                ? await ownedThreadMessages(userId, [
                      ...new Set(messages.map((message) => message.threadId))
                  ])
                : messages;
        return await setFlag(userId, whole, flag);
    }

    // What somebody just said about these messages, before they are moved.
    //
    // Before, because moving one to Junk deletes its row and writes a new one in
    // the destination on the next pass - so the words and the sender have to be
    // read while they are still here. Only these two actions teach anything: the
    // filter's own verdicts teach it nothing, or it would converge on believing
    // whatever it happened to think first - which is what `teach: false` is for.
    if ((action === "junk" || action === "not-junk") && options.teach !== false) {
        const verdict = action === "junk" ? "junk" : "good";
        // Concurrently, and once per message rather than once per row: teaching
        // is keyed on the Message-Id, so the same message selected in two
        // folders of one mailbox must not be counted twice - which is what
        // running them one after another used to prevent by accident.
        const taught = new Set<string>();
        const once = messages.filter((message) => {
            const key = `${message.accountId}:${message.messageId.trim()}`;
            if (taught.has(key)) return false;
            taught.add(key);
            return true;
        });
        await Promise.all(once.map((message) => teachSpam(message.accountId, message.id, verdict)));
    }

    let done = 0;
    for (const [accountId, mine] of groupByAccount(messages)) {
        const account = await ownedAccount(userId, accountId);
        /** Where the messages went, so it can be read again before anybody looks
         *  for them there. */
        const landed = new Set<string>();
        /** What each folder's unread number owes this action, so the rail is
         *  right the moment the answer lands rather than at the next sync. */
        const deltas = new Map<string, number>();
        await withImap(account, async (client) => {
            for (const [folderId, rows] of byFolder(mine)) {
                const folder = await prisma.mailFolder.findUnique({
                    where: { id: folderId },
                    select: { path: true }
                });
                if (!folder) continue;
                const uids = rows.map((row) => Number(row.uid));
                const lock = await client.getMailboxLock(folder.path);
                let target = "";
                try {
                    const outcome = await applyOne(
                        client,
                        account.id,
                        folderId,
                        uids,
                        rows,
                        action
                    );
                    done += outcome.done;
                    target = outcome.movedTo;
                    // Unread mail leaving is unread mail the folder no longer
                    // has, whether it went to Trash or was destroyed outright.
                    addDelta(deltas, folderId, -outcome.unseen);
                    if (target) addDelta(deltas, target, outcome.unseen);
                } finally {
                    lock.release();
                }
                if (target) landed.add(target);
            }
        });
        await nudgeFolderUnread(deltas);
        publishMail({ accountId, kind: "messages", actorId: userId });
        // Where they landed, read after the answer rather than before it.
        //
        // A message that has been archived has to be in Archive by the time
        // anybody looks there, and that means reading the destination - which is
        // a second mailbox, a second lock and a second pass over its uids. Doing
        // it before answering held the whole click: a server action is what the
        // router waits on, so for as long as this ran the screen ignored the next
        // conversation somebody clicked. That is the "it goes dead for a moment
        // after deleting" this exists to end.
        //
        // It is not skipped, only moved: the stream frame that follows is what
        // redraws the screen once the new home is readable, and until then the
        // list somebody is looking at is already right.
        if (options.settle !== false) settle(account, [...landed], userId);
    }
    if (options.settle !== false) {
        await refreshThreadsFor(messages.map((message) => message.accountId));
    }
    return done;
}

/**
 * Read the folders an action moved messages into, once the answer has gone.
 *
 * `after` is what makes this genuinely off the critical path: the work runs when
 * the response has been flushed, so nothing anybody clicks is queued behind it.
 * Outside a request - a rule firing on a sync, a sweep - there is no response to
 * be after, so it is simply awaited there instead, which is what that path always
 * did.
 *
 * A connection of its own, because the one the move was made on has been handed
 * back by the time this runs. That is a second login to somebody's mail server,
 * and it buys a mailbox that answers a click while it happens.
 */
function settle(
    account: MailConnectionSource & { id: string },
    folderIds: readonly string[],
    userId: string
): void {
    if (folderIds.length === 0) return;
    const read = async (): Promise<void> => {
        await withImap(account, async (client) => {
            for (const folderId of folderIds) {
                await catchUpFolder(client, account.id, folderId).catch(() => undefined);
            }
        }).catch(() => undefined);
        await refreshThreadsFor([account.id]).catch(() => undefined);
        publishMail({ accountId: account.id, kind: "messages", actorId: userId });
    };
    try {
        after(read);
    } catch {
        // No request to be after: whatever called this is a background pass, and
        // there is nothing waiting on it to be kind to.
        void read();
    }
}

/**
 * Set or clear a flag: here first, on the mail server after the answer.
 *
 * This is the one action that happens because somebody is reading, rather than
 * because they pressed something, and it was the slowest thing on the screen. It
 * went the same way a move does - open a connection, take a mailbox lock, STORE,
 * and only then write the row - so opening a message cost a full round trip to
 * somebody else's IMAP server before the list stopped being bold. Behind a
 * connection already busy fetching the body of the message being opened, it cost
 * that wait twice.
 *
 * And when it failed it failed silently. The row is written only after the
 * server says yes, so a refused or timed-out STORE left the message unread with
 * nothing said to anybody - which is exactly "I open it and it does not go
 * read", reported as a mystery because from the screen that is what it is.
 *
 * So the order is turned around. The row and its conversation are written now,
 * which is what every screen reads and therefore what the reader sees; the flag
 * goes to the mail server once the answer has been flushed, on the same `after`
 * the folder catch-up already uses. A push that never lands is not lost data -
 * the next sync reads the server's own flags and puts the message back to
 * whatever the server believes, which is the truth and was always going to win.
 *
 * A move is deliberately NOT done this way. Deleting a row for a message the
 * server still holds is a message that comes back on the next sync having been
 * gone from the screen, and that is a worse lie than a slow click.
 */
async function setFlag(
    userId: string,
    messages: readonly {
        id: string;
        uid: bigint;
        accountId: string;
        folderId: string;
        seen: boolean;
    }[],
    flag: { flag: string; add: boolean; column: string }
): Promise<number> {
    await prisma.mailMessage.updateMany({
        where: { id: { in: messages.map((message) => message.id) } },
        data: { [flag.column]: flag.add }
    });
    const accountIds = [...new Set(messages.map((message) => message.accountId))];
    // The conversation's own counts, which is what the list draws: a message
    // marked read whose thread still says one unread is a row that stays bold.
    await refreshThreadsFor(accountIds);
    // And the number beside the folder in the rail, which is the server's and
    // therefore moves for nobody until a sync - counted off what actually
    // changed state rather than off how many were asked for, so marking four
    // messages read when three already were takes one off, not four.
    if (flag.column === "seen") {
        const deltas = new Map<string, number>();
        for (const message of messages) {
            if (message.seen === flag.add) continue;
            addDelta(deltas, message.folderId, flag.add ? -1 : 1);
        }
        await nudgeFolderUnread(deltas);
    }
    for (const accountId of accountIds) {
        publishMail({ accountId, kind: "messages", actorId: userId });
    }

    const push = async (): Promise<void> => {
        for (const [accountId, mine] of groupByAccount(messages)) {
            const account = await ownedAccount(userId, accountId).catch(() => null);
            if (!account) continue;
            await withImap(account, async (client) => {
                for (const [folderId, rows] of byFolder(mine)) {
                    const folder = await prisma.mailFolder.findUnique({
                        where: { id: folderId },
                        select: { path: true }
                    });
                    if (!folder) continue;
                    const uids = rows.map((row) => Number(row.uid));
                    const lock = await client.getMailboxLock(folder.path);
                    try {
                        // A keyword is only worth mirroring where the folder keeps
                        // it, and a writable open is the one moment the server
                        // says so. Learned here so sync knows it may believe the
                        // server's silence about the keyword from now on.
                        if (flag.flag === IMPORTANT_KEYWORD && keepsKeyword(client)) {
                            await prisma.mailFolder.update({
                                where: { id: folderId },
                                data: { keywords: true }
                            });
                        }
                        if (flag.add) {
                            await client.messageFlagsAdd(uids, [flag.flag], { uid: true });
                        } else {
                            await client.messageFlagsRemove(uids, [flag.flag], { uid: true });
                        }
                    } finally {
                        lock.release();
                    }
                }
            }).catch(() => undefined);
        }
    };
    try {
        after(push);
    } catch {
        // No request to be after - a rule firing on a sync, a sweep - so there is
        // nothing waiting on this to be kind to.
        void push();
    }
    return messages.length;
}

/** What one folder's worth of an action did: how many messages it touched, and
 *  where they went if they went anywhere. */
interface Applied {
    readonly done: number;
    readonly movedTo: string;
    /** How many of them were unread, so the folder they left and the folder they
     *  arrived in can both say so before the next sync. */
    readonly unseen: number;
}

async function applyOne(
    client: ImapFlow,
    accountId: string,
    folderId: string,
    uids: number[],
    rows: readonly { id: string; seen: boolean }[],
    action: MailAction
): Promise<Applied> {
    const unseen = rows.filter((row) => !row.seen).length;
    const flag = FLAG_ACTIONS[action];
    if (flag) {
        const changed = flag.add
            ? await client.messageFlagsAdd(uids, [flag.flag], { uid: true })
            : await client.messageFlagsRemove(uids, [flag.flag], { uid: true });
        if (!changed) return { done: 0, movedTo: "", unseen: 0 };
        await prisma.mailMessage.updateMany({
            where: { id: { in: rows.map((row) => row.id) } },
            data: { [flag.column]: flag.add }
        });
        return { done: rows.length, movedTo: "", unseen: 0 };
    }

    if (action === "delete") {
        // Deleting outright, not into Trash. Only ever reached from the Trash
        // folder's own Delete button and from Empty trash, both of which say so.
        const removed = await client.messageDelete(uids, { uid: true });
        if (!removed) return { done: 0, movedTo: "", unseen: 0 };
        await prisma.mailMessage.deleteMany({ where: { id: { in: rows.map((row) => row.id) } } });
        return { done: rows.length, movedTo: "", unseen };
    }

    const role = MOVE_ACTIONS[action];
    if (!role) return { done: 0, movedTo: "", unseen: 0 };
    const target = await folderForRole(accountId, role);
    if (target.id === folderId) return { done: 0, movedTo: "", unseen: 0 };
    const moved = await client.messageMove(uids, target.path, { uid: true });
    if (!moved) return { done: 0, movedTo: "", unseen: 0 };
    // The uids the messages now have are the destination's, and the server may
    // not have said what they are. The rows are dropped rather than guessed at:
    // the next pass over the destination folder picks them up with the uids the
    // server actually gave them, and a guessed uid is a row that points at
    // somebody else's message.
    await prisma.mailMessage.deleteMany({ where: { id: { in: rows.map((row) => row.id) } } });
    return { done: rows.length, movedTo: target.id, unseen };
}

function groupByAccount<T extends { accountId: string }>(rows: readonly T[]): Map<string, T[]> {
    const out = new Map<string, T[]>();
    for (const row of rows) {
        const held = out.get(row.accountId);
        if (held) held.push(row);
        else out.set(row.accountId, [row]);
    }
    return out;
}

async function refreshThreadsFor(accountIds: readonly string[]): Promise<void> {
    for (const accountId of new Set(accountIds)) await refreshThreads(accountId);
}

/** Put a set of messages in a named folder, for the drag onto the rail and the
 *  Move to menu. */
export async function moveMessages(
    userId: string,
    messageIds: readonly string[],
    folderId: string
): Promise<number> {
    const destination = await prisma.mailFolder.findFirst({
        where: { id: folderId, account: { userId } },
        select: { id: true, accountId: true, path: true }
    });
    if (!destination) throw new MailAccessError("That folder is not yours.");

    const messages = (await ownedMessages(userId, messageIds)).filter(
        (message) => message.accountId === destination.accountId
    );
    if (messages.length === 0) return 0;

    const account = await ownedAccount(userId, destination.accountId);
    let moved = 0;
    /** What the move owes each folder's unread number - see `folder-counts`. */
    const deltas = new Map<string, number>();
    await withImap(account, async (client) => {
        for (const [sourceId, rows] of byFolder(messages)) {
            if (sourceId === destination.id) continue;
            const source = await prisma.mailFolder.findUnique({
                where: { id: sourceId },
                select: { path: true }
            });
            if (!source) continue;
            const lock = await client.getMailboxLock(source.path);
            try {
                const ok = await client.messageMove(
                    rows.map((row) => Number(row.uid)),
                    destination.path,
                    { uid: true }
                );
                if (!ok) continue;
                await prisma.mailMessage.deleteMany({
                    where: { id: { in: rows.map((row) => row.id) } }
                });
                moved += rows.length;
                for (const [source, by] of unseenByFolder(rows, -1)) addDelta(deltas, source, by);
                addDelta(deltas, destination.id, rows.filter((row) => !row.seen).length);
            } finally {
                lock.release();
            }
        }
    });
    await nudgeFolderUnread(deltas);
    await refreshThreads(destination.accountId);
    publishMail({ accountId: destination.accountId, kind: "messages", actorId: userId });
    return moved;
}

/**
 * Put a message out of sight until a time.
 *
 * Kept entirely here rather than on the server, because IMAP has no notion of
 * it: the message stays exactly where it is and this app stops listing it in the
 * inbox until the hour comes round. That means a snoozed message is still in the
 * inbox on somebody's phone, which is the honest behaviour - the alternative is
 * moving their mail into a folder they never asked for.
 */
export async function snoozeMessages(
    userId: string,
    messageIds: readonly string[],
    until: Date | null
): Promise<number> {
    const messages = await ownedMessages(userId, messageIds);
    if (messages.length === 0) return 0;
    await prisma.mailMessage.updateMany({
        where: { id: { in: messages.map((message) => message.id) } },
        data: { snoozedUntil: until }
    });
    for (const accountId of new Set(messages.map((message) => message.accountId))) {
        publishMail({ accountId, kind: "messages", actorId: userId });
    }
    return messages.length;
}

/* -------------------------------------------------------------------------- */
/* Opening one                                                                 */
/* -------------------------------------------------------------------------- */

/** A message with its body, as the reading pane needs it. */
export interface MailBody {
    readonly text: string;
    readonly html: string;
}

/**
 * The body of one message, fetched the first time and kept after that.
 *
 * `\Seen` is not set here. Whether opening something marks it read is a decision
 * the screen makes - a preview pane that marks everything read as you arrow
 * through it is the most complained-about behaviour in any mail client - so the
 * fetch peeks and the marking is a separate action the browser asks for.
 */
export async function loadBody(userId: string, messageId: string): Promise<MailBody> {
    const message = await prisma.mailMessage.findFirst({
        where: { id: messageId, account: { userId } },
        select: {
            id: true,
            uid: true,
            accountId: true,
            bodyText: true,
            bodyHtml: true,
            // For the subscription registry below, which can only read a footer
            // once there is a body to read.
            headers: true,
            fromJson: true,
            listId: true,
            sentAt: true,
            folder: { select: { path: true, role: true } }
        }
    });
    if (!message) throw new MailAccessError("That message is not yours.");
    if (message.bodyText !== null || message.bodyHtml !== null) {
        return { text: message.bodyText ?? "", html: message.bodyHtml ?? "" };
    }

    const account = await prisma.mailAccount.findUnique({
        where: { id: message.accountId },
        select: ACCOUNT_COLUMNS
    });
    if (!account) throw new MailAccessError();

    const body = await withImap(account, async (client) => {
        const lock = await client.getMailboxLock(message.folder.path, { readOnly: true });
        try {
            const one = await client.fetchOne(
                String(message.uid),
                { uid: true, bodyStructure: true },
                { uid: true }
            );
            if (!one) return { text: "", html: "" };
            const shape = readShape(one.bodyStructure);
            const [text, html] = await Promise.all([
                shape.textPart
                    ? downloadPart(client, Number(message.uid), shape.textPart)
                    : Promise.resolve(""),
                shape.htmlPart
                    ? downloadPart(client, Number(message.uid), shape.htmlPart)
                    : Promise.resolve("")
            ]);
            return { text, html };
        } finally {
            lock.release();
        }
    });

    await prisma.mailMessage.update({
        where: { id: message.id },
        data: { bodyText: body.text, bodyHtml: body.html }
    });

    // The one moment a message's footer can be read. Plenty of mail that is
    // unmistakably a mailing list publishes no `List-Unsubscribe` header at all,
    // and its only way out is a link in a sentence - which is not on the row
    // until now. Counted as nothing: this is mail being opened, not arriving.
    if (message.folder.role !== "sent" && message.folder.role !== "drafts") {
        await recordSubscription(message.accountId, {
            from: addressesFrom(message.fromJson),
            headers: (message.headers as Record<string, string> | null) ?? null,
            html: body.html,
            text: body.text,
            listId: message.listId,
            at: message.sentAt,
            counts: false
        });
    }
    return body;
}

/**
 * One part, as text.
 *
 * imapflow undoes the transfer encoding on the way out of `download`, and stops
 * there: the bytes are still in whatever character set the part declared, and
 * reading them as UTF-8 is what turns a Latin-1 footer into mojibake. So the
 * charset is applied here, from what the server said about the part.
 *
 * A stream rather than a buffer from the socket, so a forty-megabyte message is
 * never held twice.
 */
async function downloadPart(client: ImapFlow, uid: number, part: string): Promise<string> {
    const download = await client.download(String(uid), part, { uid: true });
    if (!download?.content) return "";
    const chunks: Buffer[] = [];
    for await (const chunk of download.content) chunks.push(chunk as Buffer);
    const bytes = Buffer.concat(chunks);
    const text = decodePart(bytes, { charset: download.meta?.charset });
    // A plain part sent `format=flowed` arrives cut into 72-character pieces,
    // and joining them back is the difference between a paragraph and a wall of
    // ragged lines.
    return download.meta?.flowed ? unflow(text, download.meta.delSp) : text;
}

/**
 * One attachment's bytes.
 *
 * Streamed straight through to the browser rather than stored: a mailbox's
 * attachments are already on the mail server and copying every one of them onto
 * this disk to serve it once would make a mail client into a second copy of
 * everybody's mail. Saving one to Drive is a deliberate action with its own
 * button.
 */
export async function readAttachment(
    userId: string,
    attachmentId: string
): Promise<{ name: string; contentType: string; bytes: Buffer }> {
    const attachment = await prisma.mailAttachment.findFirst({
        where: { id: attachmentId, message: { account: { userId } } },
        select: {
            part: true,
            name: true,
            contentType: true,
            message: {
                select: { uid: true, accountId: true, folder: { select: { path: true } } }
            }
        }
    });
    if (!attachment) throw new MailAccessError("That attachment is not yours.");

    const account = await prisma.mailAccount.findUnique({
        where: { id: attachment.message.accountId },
        select: ACCOUNT_COLUMNS
    });
    if (!account) throw new MailAccessError();

    const bytes = await withImap(account, async (client) => {
        const lock = await client.getMailboxLock(attachment.message.folder.path, {
            readOnly: true
        });
        try {
            const download = await client.download(
                String(attachment.message.uid),
                attachment.part,
                {
                    uid: true
                }
            );
            if (!download?.content) return Buffer.alloc(0);
            const chunks: Buffer[] = [];
            for await (const chunk of download.content) chunks.push(chunk as Buffer);
            return Buffer.concat(chunks);
        } finally {
            lock.release();
        }
    });

    return { name: attachment.name, contentType: attachment.contentType, bytes };
}

/**
 * Wake everything whose hour has come.
 *
 * Run from the schedule. A message whose snooze has passed simply stops being
 * hidden; nothing is moved, because nothing was moved to hide it.
 */
export async function wakeSnoozed(): Promise<number> {
    const due = await prisma.mailMessage.findMany({
        where: { snoozedUntil: { not: null, lte: new Date() } },
        select: { id: true, accountId: true, account: { select: { userId: true } } },
        take: 500
    });
    if (due.length === 0) return 0;
    await prisma.mailMessage.updateMany({
        where: { id: { in: due.map((message) => message.id) } },
        data: { snoozedUntil: null }
    });
    for (const message of due) {
        publishMail({
            accountId: message.accountId,
            kind: "messages",
            actorId: message.account.userId
        });
    }
    return due.length;
}

/**
 * One message and the privacy settings of the mailbox it is in, for the reading
 * pane.
 *
 * Both in one call because they are always wanted together and the settings are
 * per mailbox rather than per person: somebody with a work mailbox and a
 * personal one has made two different decisions about remote content, and the
 * reading pane has to read the one belonging to the message in front of it.
 */
export async function messageForReading(userId: string, messageId: string) {
    const message = await prisma.mailMessage.findFirst({
        where: { id: messageId, account: { userId } },
        select: {
            accountId: true,
            bodyHtml: true,
            bodyText: true,
            wantsReceipt: true,
            headers: true,
            fromJson: true,
            subject: true,
            toJson: true,
            ccJson: true,
            replyToJson: true,
            listId: true,
            sentAt: true,
            account: {
                select: { remoteContent: true, cleanLinks: true, nameTrackers: true }
            }
        }
    });
    if (!message) return null;
    return {
        accountId: message.accountId,
        policy: message.account,
        // Who the message was between, for answering it. Read here rather than
        // in a second query, because every caller that wants the body to quote
        // wants these in the same breath.
        envelope: {
            id: messageId,
            accountId: message.accountId,
            subject: message.subject,
            from: addressesFrom(message.fromJson),
            to: addressesFrom(message.toJson),
            cc: addressesFrom(message.ccJson),
            replyTo: addressesFrom(message.replyToJson),
            listId: message.listId,
            sentAt: message.sentAt.toISOString()
        },
        row: {
            bodyHtml: message.bodyHtml,
            bodyText: message.bodyText,
            wantsReceipt: message.wantsReceipt,
            headers: message.headers,
            fromJson: message.fromJson
        }
    };
}
