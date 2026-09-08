/**
 * Which folder on a mailbox is its Trash, its Archive, its Junk.
 *
 * Its own module because three different things need the answer and one of them
 * cannot import the others: the actions that move mail, the away replies, and
 * the junk filter, which the actions in turn call. A shared question with three
 * callers in a cycle is exactly what a small module is for.
 *
 * The subtlety worth keeping in one place is the ordering. A role its owner
 * pointed at wins over one matched from a folder's name, so a mailbox where both
 * a "Spam" and a "Junk" folder exist settles on whichever one somebody said,
 * and settles the same way everywhere.
 */

import { prisma } from "@polaris/db";
import type * as core from "@polaris/core";

/** Raised when a mailbox has no folder for the role an action needs. Carries the
 *  role and the mailbox so the screen can ask which folder it is rather than
 *  telling somebody their archive failed. */
export class MailFolderRoleMissing extends Error {
    public readonly role: core.MailFolderRole;

    public readonly accountId: string;

    public constructor(role: core.MailFolderRole, accountId: string) {
        super(`This mailbox has no ${role} folder.`);
        this.name = "MailFolderRoleMissing";
        this.role = role;
        this.accountId = accountId;
    }
}

/** The folder with a role, or null. Never creates one: a mailbox with no folder
 *  for a role either has one under a name nobody recognised - which its owner
 *  can point at, once - or genuinely has none, and then making it is their
 *  decision to take deliberately. */
export async function findFolderForRole(
    accountId: string,
    role: core.MailFolderRole
): Promise<{ id: string; path: string } | null> {
    return prisma.mailFolder.findFirst({
        where: { accountId, role },
        orderBy: { roleLocked: "desc" },
        select: { id: true, path: true }
    });
}

/** The same, refused loudly, for the callers that cannot carry on without one. */
export async function folderForRole(
    accountId: string,
    role: core.MailFolderRole
): Promise<{ id: string; path: string }> {
    const held = await findFolderForRole(accountId, role);
    if (!held) throw new MailFolderRoleMissing(role, accountId);
    return held;
}
