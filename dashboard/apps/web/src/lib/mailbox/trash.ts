/**
 * The trash, as a place things come back from.
 *
 * A mail client that can only delete out of the trash is a client where a
 * mis-click is permanent, so two things live here: putting a message back where
 * it came from, and emptying the whole folder deliberately.
 *
 * **Back where it came from, not into the inbox.** Somebody who files mail into
 * folders deleted that message out of a folder, and answering "put it back" with
 * the inbox is a second thing for them to undo. Where it was is written down at
 * the moment of the move (`MailTrashOrigin`) because the message row itself does
 * not survive it: a move deletes the row and the destination writes a new one
 * with the uid the server chose. The Message-Id header is what survives, so that
 * is the key. A folder that has since been deleted leaves no row, and the
 * fallback is the inbox - which is the best a client can do and what every
 * client that never wrote it down does always.
 *
 * **Emptying is the server's `delete`, folder-wide.** Not the cached window:
 * Polaris holds the newest few hundred messages of a folder, and a button that
 * says "empty" and leaves nine thousand older ones on the server is a button
 * that lies. The search is `all`, which the server resolves.
 */

import { withImap } from "./imap";
import { prisma } from "@polaris/db";
import { publishMail } from "./live";
import { catchUpFolder } from "./sync";
import { refreshThreads } from "./sync";
import { findFolderForRole } from "./folder-roles";
import { MailAccessError, ownedAccount, ownedMessages } from "./access";
import { addDelta, nudgeFolderUnread, unseenByFolder } from "./folder-counts";

/** What is remembered about a message on its way to the trash. */
interface Trashed {
    readonly messageId: string;
    readonly folderId: string;
}

/**
 * Write down where these messages were, before they are moved out of it.
 *
 * Called with the source folder still open, from the one place that moves things
 * into the trash. A message with no Message-Id header - rare, and always
 * something generated - is skipped rather than keyed on an empty string, which
 * would make every such message in a mailbox the same row.
 */
export async function rememberTrashOrigins(
    accountId: string,
    rows: readonly Trashed[]
): Promise<void> {
    const worth = rows.filter((row) => row.messageId.trim().length > 0);
    if (worth.length === 0) return;
    await prisma.$transaction(
        worth.map((row) =>
            prisma.mailTrashOrigin.upsert({
                where: {
                    accountId_messageId: { accountId, messageId: row.messageId }
                },
                create: { accountId, messageId: row.messageId, folderId: row.folderId },
                // Deleted twice out of two different folders: the last move is
                // the one "put it back" has to answer.
                update: { folderId: row.folderId, at: new Date() }
            })
        )
    );
}

/** Forget an origin, for messages leaving the trash by any other door. */
export async function forgetTrashOrigins(
    accountId: string,
    messageIds: readonly string[]
): Promise<void> {
    const worth = messageIds.filter((id) => id.trim().length > 0);
    if (worth.length === 0) return;
    await prisma.mailTrashOrigin.deleteMany({
        where: { accountId, messageId: { in: worth } }
    });
}

/**
 * Take messages out of the trash and put them back.
 *
 * Grouped by where each one is going, because that is what an IMAP move takes:
 * one source mailbox, one destination, a set of uids. A restore of forty
 * messages that came from three folders is three commands.
 */
export async function restoreFromTrash(
    userId: string,
    messageIds: readonly string[]
): Promise<number> {
    const messages = await ownedMessages(userId, messageIds);
    if (messages.length === 0) return 0;

    let moved = 0;
    for (const accountId of new Set(messages.map((message) => message.accountId))) {
        const mine = messages.filter((message) => message.accountId === accountId);
        const account = await ownedAccount(userId, accountId);
        const origins = await prisma.mailTrashOrigin.findMany({
            where: {
                accountId,
                messageId: { in: mine.map((message) => message.messageId).filter(Boolean) }
            },
            select: { messageId: true, folderId: true, folder: { select: { path: true } } }
        });
        const cameFrom = new Map(origins.map((row) => [row.messageId, row]));
        const inbox = await findFolderForRole(accountId, "inbox");

        /** Which folder each message is going to, as ids, so the ones with no
         *  record of where they were still go somewhere sensible. */
        const targets = new Map<string, { id: string; path: string }>();
        for (const message of mine) {
            const origin = cameFrom.get(message.messageId);
            const target = origin
                ? { id: origin.folderId, path: origin.folder.path }
                : inbox
                  ? { id: inbox.id, path: inbox.path }
                  : null;
            if (!target || target.id === message.folderId) continue;
            targets.set(message.id, target);
        }
        if (targets.size === 0) continue;

        const deltas = new Map<string, number>();
        const landed = new Set<string>();
        await withImap(account, async (client) => {
            // Source folder, then destination: both are what a move command
            // names, and a mailbox lock is per source.
            for (const sourceId of new Set(mine.map((message) => message.folderId))) {
                const source = await prisma.mailFolder.findUnique({
                    where: { id: sourceId },
                    select: { path: true }
                });
                if (!source) continue;
                const here = mine.filter(
                    (message) => message.folderId === sourceId && targets.has(message.id)
                );
                if (here.length === 0) continue;
                const lock = await client.getMailboxLock(source.path);
                try {
                    for (const path of new Set(
                        here.map((message) => targets.get(message.id)?.path ?? "")
                    )) {
                        if (!path) continue;
                        const going = here.filter(
                            (message) => targets.get(message.id)?.path === path
                        );
                        const ok = await client.messageMove(
                            going.map((message) => Number(message.uid)),
                            path,
                            { uid: true }
                        );
                        if (!ok) continue;
                        // The row goes with the move: the destination decides the
                        // uid, and a guessed one points at somebody else's mail.
                        await prisma.mailMessage.deleteMany({
                            where: { id: { in: going.map((message) => message.id) } }
                        });
                        moved += going.length;
                        const target = targets.get(going[0]?.id ?? "");
                        if (target) {
                            landed.add(target.id);
                            addDelta(
                                deltas,
                                target.id,
                                going.filter((message) => !message.seen).length
                            );
                        }
                        for (const [folderId, by] of unseenByFolder(going, -1)) {
                            addDelta(deltas, folderId, by);
                        }
                    }
                } finally {
                    lock.release();
                }
            }
        });

        await forgetTrashOrigins(
            accountId,
            mine.map((message) => message.messageId)
        );
        await nudgeFolderUnread(deltas);
        await refreshThreads(accountId);
        publishMail({ accountId, kind: "messages", actorId: userId });
        // The folders they landed in are read on a connection of their own, once
        // the answer has gone - the same arrangement every other move here uses,
        // so nothing anybody clicks is queued behind it.
        settleLater(userId, accountId, [...landed]);
    }
    return moved;
}

/**
 * Destroy everything in one mailbox's trash - or its spam folder.
 *
 * Server-side and folder-wide, so it empties what the server holds rather than
 * the window Polaris has read. What comes back is how many rows were dropped
 * here, which is what the screen can honestly say it removed.
 */
export async function emptyFolderOfRole(
    userId: string,
    accountId: string,
    role: "trash" | "junk"
): Promise<number> {
    const account = await ownedAccount(userId, accountId);
    const folder = await findFolderForRole(accountId, role);
    if (!folder) return 0;

    await withImap(account, async (client) => {
        const lock = await client.getMailboxLock(folder.path);
        try {
            // `all` is the server's own search, so this reaches every message in
            // the folder and not only the ones cached here.
            await client.messageDelete({ all: true }, { uid: true });
        } finally {
            lock.release();
        }
    });

    const { count } = await prisma.mailMessage.deleteMany({ where: { folderId: folder.id } });
    await prisma.mailFolder.update({
        where: { id: folder.id },
        data: { total: 0, unread: 0 }
    });
    // Nothing in there came from anywhere any more.
    if (role === "trash") await prisma.mailTrashOrigin.deleteMany({ where: { accountId } });
    await refreshThreads(accountId);
    publishMail({ accountId, kind: "folders", actorId: userId });
    publishMail({ accountId, kind: "messages", actorId: userId, folderId: folder.id });
    return count;
}

/** Every mailbox of this person's that has such a folder, for the button that
 *  empties the merged view rather than one account's. */
export async function emptyEveryFolderOfRole(
    userId: string,
    role: "trash" | "junk",
    accountIds: readonly string[]
): Promise<number> {
    const mine = await prisma.mailAccount.findMany({
        where: {
            userId,
            ...(accountIds.length > 0 ? { id: { in: [...accountIds] } } : {})
        },
        select: { id: true }
    });
    if (mine.length === 0) throw new MailAccessError();
    let dropped = 0;
    for (const account of mine) {
        dropped += await emptyFolderOfRole(userId, account.id, role).catch(() => 0);
    }
    return dropped;
}

/** Read the folders a restore landed in, on a connection of their own. Failures
 *  are silent: the next sync reads them anyway, and nothing is waiting. */
function settleLater(userId: string, accountId: string, folderIds: readonly string[]): void {
    if (folderIds.length === 0) return;
    void (async () => {
        try {
            const account = await ownedAccount(userId, accountId);
            await withImap(account, async (client) => {
                for (const folderId of folderIds) {
                    await catchUpFolder(client, accountId, folderId).catch(() => undefined);
                }
            });
            publishMail({ accountId, kind: "messages", actorId: userId });
        } catch {
            // Nothing to say: the folder is read again on the next pass.
        }
    })();
}
