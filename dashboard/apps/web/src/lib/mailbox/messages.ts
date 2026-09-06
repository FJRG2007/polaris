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

import { withImap } from "./imap";
import { prisma } from "@polaris/db";
import { publishMail } from "./live";
import * as core from "@polaris/core";
import { readShape } from "./structure";
import { refreshThreads } from "./sync";
import type { ImapFlow } from "imapflow";
import { ACCOUNT_COLUMNS, MailAccessError, ownedAccount, ownedMessages } from "./access";

/** What a message action is asked for as. */
export type MailAction =
    | "read"
    | "unread"
    | "star"
    | "unstar"
    | "archive"
    | "trash"
    | "delete"
    | "junk"
    | "not-junk"
    | "inbox";

/** The flag an action sets, for the four that are flags rather than moves. */
const FLAG_ACTIONS: Partial<Record<MailAction, { flag: string; add: boolean; column: "seen" | "flagged" }>> = {
    read: { flag: "\\Seen", add: true, column: "seen" },
    unread: { flag: "\\Seen", add: false, column: "seen" },
    star: { flag: "\\Flagged", add: true, column: "flagged" },
    unstar: { flag: "\\Flagged", add: false, column: "flagged" }
};

/** Where each moving action puts a message. */
const MOVE_ACTIONS: Partial<Record<MailAction, core.MailFolderRole>> = {
    archive: "archive",
    trash: "trash",
    junk: "junk",
    "not-junk": "inbox",
    inbox: "inbox"
};

/**
 * Raised when an action needs a folder this mailbox has no equivalent of.
 *
 * It used to create one. That was wrong, and somebody found out the way people
 * find these things out: a mailbox whose trash is called `Papelera` ended up
 * with a second, empty `Trash` that Polaris had written into their mail server,
 * and which they then saw in every other client they own. Making a folder in
 * somebody else's mailbox is not a default, whatever the convenience.
 *
 * So it refuses, and carries what the screen needs to ask: which role, and what
 * the account's folders are, so a reader can point at the one they already use.
 */
export class MailFolderRoleMissing extends Error {
    public readonly role: core.MailFolderRole;
    public readonly accountId: string;

    public constructor(role: core.MailFolderRole, accountId: string) {
        super(`This mailbox has no folder set as its ${role}.`);
        this.name = "MailFolderRoleMissing";
        this.role = role;
        this.accountId = accountId;
    }
}

/**
 * The folder on this account with a given role.
 *
 * Never creates one. A mailbox that has no folder for a role either has one
 * under a name nobody recognised - which its owner can point at, once - or
 * genuinely has none, and then making it is their decision to take deliberately.
 */
async function folderForRole(
    accountId: string,
    role: core.MailFolderRole
): Promise<{ id: string; path: string }> {
    const held = await prisma.mailFolder.findFirst({
        where: { accountId, role },
        // A role its owner chose wins over one matched from a name, so pointing
        // at the right folder settles it even where a wrong one still matches.
        orderBy: { roleLocked: "desc" },
        select: { id: true, path: true }
    });
    if (!held) throw new MailFolderRoleMissing(role, accountId);
    return held;
}

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
    const name = role === "archive" ? "Archive" : role === "junk" ? "Junk" : role === "trash" ? "Trash" : "Archive";
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
    action: MailAction
): Promise<number> {
    const messages = await ownedMessages(userId, messageIds);
    if (messages.length === 0) return 0;

    let done = 0;
    for (const [accountId, mine] of groupByAccount(messages)) {
        const account = await ownedAccount(userId, accountId);
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
                    done += await applyOne(client, account.id, folderId, uids, rows, action);
                } finally {
                    lock.release();
                }
            }
        });
        publishMail({ accountId, kind: "messages", actorId: userId });
    }
    await refreshThreadsFor(messages.map((message) => message.accountId));
    return done;
}

async function applyOne(
    client: ImapFlow,
    accountId: string,
    folderId: string,
    uids: number[],
    rows: readonly { id: string }[],
    action: MailAction
): Promise<number> {
    const flag = FLAG_ACTIONS[action];
    if (flag) {
        const changed = flag.add
            ? await client.messageFlagsAdd(uids, [flag.flag], { uid: true })
            : await client.messageFlagsRemove(uids, [flag.flag], { uid: true });
        if (!changed) return 0;
        await prisma.mailMessage.updateMany({
            where: { id: { in: rows.map((row) => row.id) } },
            data: { [flag.column]: flag.add }
        });
        return rows.length;
    }

    if (action === "delete") {
        // Deleting outright, not into Trash. Only ever reached from the Trash
        // folder's own Delete button and from Empty trash, both of which say so.
        const removed = await client.messageDelete(uids, { uid: true });
        if (!removed) return 0;
        await prisma.mailMessage.deleteMany({ where: { id: { in: rows.map((row) => row.id) } } });
        return rows.length;
    }

    const role = MOVE_ACTIONS[action];
    if (!role) return 0;
    const target = await folderForRole(accountId, role);
    if (target.id === folderId) return 0;
    const moved = await client.messageMove(uids, target.path, { uid: true });
    if (!moved) return 0;
    // The uids the messages now have are the destination's, and the server may
    // not have said what they are. The rows are dropped rather than guessed at:
    // the next pass over the destination folder picks them up with the uids the
    // server actually gave them, and a guessed uid is a row that points at
    // somebody else's message.
    await prisma.mailMessage.deleteMany({ where: { id: { in: rows.map((row) => row.id) } } });
    return rows.length;
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
                await prisma.mailMessage.deleteMany({ where: { id: { in: rows.map((row) => row.id) } } });
                moved += rows.length;
            } finally {
                lock.release();
            }
        }
    });
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
            folder: { select: { path: true } }
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
                shape.textPart ? downloadPart(client, Number(message.uid), shape.textPart) : Promise.resolve(""),
                shape.htmlPart ? downloadPart(client, Number(message.uid), shape.htmlPart) : Promise.resolve("")
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
    return body;
}

/** One part, decoded. imapflow answers with a stream so the whole message is
 *  never held twice. */
async function downloadPart(client: ImapFlow, uid: number, part: string): Promise<string> {
    const download = await client.download(String(uid), part, { uid: true });
    if (!download?.content) return "";
    const chunks: Buffer[] = [];
    for await (const chunk of download.content) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString("utf8");
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
        const lock = await client.getMailboxLock(attachment.message.folder.path, { readOnly: true });
        try {
            const download = await client.download(String(attachment.message.uid), attachment.part, {
                uid: true
            });
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
        publishMail({ accountId: message.accountId, kind: "messages", actorId: message.account.userId });
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
            account: {
                select: { remoteContent: true, cleanLinks: true, nameTrackers: true }
            }
        }
    });
    if (!message) return null;
    return {
        accountId: message.accountId,
        policy: message.account,
        row: {
            bodyHtml: message.bodyHtml,
            bodyText: message.bodyText,
            wantsReceipt: message.wantsReceipt,
            headers: message.headers,
            fromJson: message.fromJson
        }
    };
}
