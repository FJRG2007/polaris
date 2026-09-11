/**
 * Renaming and deleting a folder, on the server as well as here.
 *
 * Both reach somebody else's IMAP host and both are what the word says: a
 * renamed folder is renamed for every client that account is open in, and a
 * deleted one takes the mail in it with it. Polaris' copy is a cache and is
 * never the point - what it does here is keep that cache honest afterwards.
 *
 * Three rules, and each is a refusal somebody would otherwise find out about
 * from a mail server:
 *
 * - A folder with a role is not somebody's to rename or delete from a rail. The
 *   inbox, Sent, Drafts, Trash, Junk, Archive and Gmail's All mail are what the
 *   app is built out of, and the ones that carry SPECIAL-USE are what every
 *   other client finds them by.
 * - A rename moves the whole subtree: IMAP renames a path, and everything under
 *   it comes with it. The rows have to follow or every child is pointing at a
 *   path that no longer exists.
 * - A folder with children cannot be deleted out from under them, which is what
 *   the servers that allow it do. Asked here, in a sentence, rather than as
 *   whatever that server says.
 *
 * Server-only.
 */

import { withImap } from "./imap";
import { prisma } from "@polaris/db";
import { publishMail } from "./live";
import { recordAudit } from "@/lib/audit-service";
import { ownedAccount, ownedFolder } from "./access";

/** Why a folder could not be renamed or deleted, in the words the screen says
 *  it in. Thrown rather than returned, the way every other refusal here is. */
export class MailFolderError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "MailFolderError";
    }
}

/** The longest a folder's name may be. Long enough for anything anybody types,
 *  short enough that a server will not refuse it for length alone. */
const NAME_MAX = 100;

/** What a folder may not be called: nothing, and nothing carrying the character
 *  the server separates folders with - that would be somebody making a subfolder
 *  by accident, under a name they cannot then find. */
function cleanName(name: string, delimiter: string): string {
    const wanted = name.trim();
    if (!wanted) throw new MailFolderError("A folder needs a name.");
    if (wanted.length > NAME_MAX) throw new MailFolderError("That name is too long.");
    if (delimiter && wanted.includes(delimiter)) {
        throw new MailFolderError(`A folder name cannot contain "${delimiter}".`);
    }
    return wanted;
}

/** Everything a folder's path is under, which is what a rename keeps. */
function parentOf(path: string, delimiter: string): string {
    if (!delimiter) return "";
    const at = path.lastIndexOf(delimiter);
    return at === -1 ? "" : path.slice(0, at);
}

/**
 * Rename a folder, and everything under it.
 *
 * The mail server does the moving - one RENAME carries the subtree - and the
 * rows are rewritten to match. The uids do not change, so nothing is resynced
 * and nobody loses their place.
 */
export async function renameFolder(userId: string, folderId: string, name: string): Promise<void> {
    const folder = await ownedFolder(userId, folderId);
    if (folder.role !== "none") {
        throw new MailFolderError("That folder is one this mailbox is built out of.");
    }
    const account = await ownedAccount(userId, folder.accountId);
    const delimiter = folder.delimiter ?? "";
    const wanted = cleanName(name, delimiter);
    if (wanted === folder.name) return;

    const parent = parentOf(folder.path, delimiter);
    const path = parent ? `${parent}${delimiter}${wanted}` : wanted;
    // The server first: a row renamed against a server that refused would be a
    // rail naming a folder nobody else can see, and the next sync would put the
    // old name back without saying why.
    await withImap(account, async (client) => {
        await client.mailboxRename(folder.path, path);
    });

    const under = `${folder.path}${delimiter}`;
    const children = delimiter
        ? await prisma.mailFolder.findMany({
              where: { accountId: folder.accountId, path: { startsWith: under } },
              select: { id: true, path: true }
          })
        : [];
    await prisma.$transaction([
        prisma.mailFolder.update({ where: { id: folder.id }, data: { name: wanted, path } }),
        ...children.map((child) =>
            prisma.mailFolder.update({
                where: { id: child.id },
                data: { path: `${path}${delimiter}${child.path.slice(under.length)}` }
            })
        )
    ]);

    await recordAudit({
        actorId: userId,
        action: "mail.folder.rename",
        targetType: "mail-folder",
        targetId: folder.id,
        // The name is the folder's own, which is the thing being changed. The
        // mail in it is nobody's business but its owner's and none of it is here.
        metadata: { from: folder.name, to: wanted }
    });
    publishMail({ accountId: folder.accountId, kind: "folders", actorId: userId });
}

/**
 * Delete a folder, and the mail in it.
 *
 * On the server, which is the only place that mail exists. The screen that asks
 * says so in those words: this is the one thing in Mail that destroys something
 * Polaris does not hold a copy of.
 */
export async function deleteFolder(userId: string, folderId: string): Promise<void> {
    const folder = await ownedFolder(userId, folderId);
    if (folder.role !== "none") {
        throw new MailFolderError("That folder is one this mailbox is built out of.");
    }
    const account = await ownedAccount(userId, folder.accountId);
    const delimiter = folder.delimiter ?? "";
    if (delimiter) {
        const child = await prisma.mailFolder.findFirst({
            where: {
                accountId: folder.accountId,
                path: { startsWith: `${folder.path}${delimiter}` }
            },
            select: { id: true }
        });
        if (child) {
            throw new MailFolderError("That folder has folders inside it. Delete those first.");
        }
    }

    await withImap(account, async (client) => {
        await client.mailboxDelete(folder.path);
    });
    // Only once the server has agreed. The messages and the conversations in it
    // cascade from the row.
    await prisma.mailFolder.delete({ where: { id: folder.id } });

    await recordAudit({
        actorId: userId,
        action: "mail.folder.delete",
        targetType: "mail-folder",
        targetId: folder.id,
        metadata: { name: folder.name }
    });
    publishMail({ accountId: folder.accountId, kind: "folders", actorId: userId });
}
