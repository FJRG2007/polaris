/**
 * Who may read a mailbox. One sentence, and there is no exception to it:
 *
 * **A mailbox is reached by being the person who linked it.**
 *
 * No administrator override, no instance-wide read, no support view. Chat's rule
 * is the same shape and for the same reason, but this one is stronger: what is
 * behind these rows is somebody else's correspondence on a server Polaris does
 * not own, reached with a credential they supplied about an account that is
 * theirs. An operator who could read it would be reading their colleagues' mail,
 * and there is no feature worth writing that door for.
 *
 * Everything that touches a mail row goes through `ownedAccount` or
 * `ownedAccounts`, which take the reader's id and narrow the query with it -
 * never through a lookup by id that is then checked, because the two are only
 * the same thing until somebody forgets the second half.
 */

import { prisma } from "@polaris/db";

/** Raised when a mailbox is asked for by somebody it does not belong to, and
 *  when one simply does not exist. The two are deliberately the same answer:
 *  telling them apart would say whether an id is a real mailbox. */
export class MailAccessError extends Error {
    public constructor(message = "That mailbox is not yours.") {
        super(message);
        this.name = "MailAccessError";
    }
}

/** The columns everything downstream needs to open a connection and act. */
export const ACCOUNT_COLUMNS = {
    id: true,
    userId: true,
    address: true,
    displayName: true,
    label: true,
    color: true,
    service: true,
    auth: true,
    connectionId: true,
    username: true,
    imapHost: true,
    imapPort: true,
    imapSecurity: true,
    smtpHost: true,
    smtpPort: true,
    smtpSecurity: true,
    encryptedSecret: true,
    secretNonce: true,
    secretKeyId: true,
    state: true,
    stateDetail: true,
    lastSyncAt: true,
    lastOkAt: true,
    pollSeconds: true,
    notify: true,
    unified: true,
    appendToSent: true,
    signature: true,
    signatureAboveQuote: true,
    remoteContent: true,
    nameTrackers: true,
    answerReceipts: true,
    cleanLinks: true,
    vacationEnabled: true,
    vacationSubject: true,
    vacationBody: true,
    vacationStartsAt: true,
    vacationEndsAt: true,
    vacationRepeatDays: true,
    position: true,
    createdAt: true
} as const;

export type MailAccountRow = Awaited<ReturnType<typeof ownedAccount>>;

/** One mailbox, if it is this person's. Throws otherwise. */
export async function ownedAccount(userId: string, accountId: string) {
    const account = await prisma.mailAccount.findFirst({
        where: { id: accountId, userId },
        select: ACCOUNT_COLUMNS
    });
    if (!account) throw new MailAccessError();
    return account;
}

/** Every mailbox this person has, in rail order. */
export function ownedAccounts(userId: string) {
    return prisma.mailAccount.findMany({
        where: { userId },
        select: ACCOUNT_COLUMNS,
        orderBy: [{ position: "asc" }, { createdAt: "asc" }]
    });
}

/** The ids of this person's mailboxes, for the queries that span all of them. */
export async function ownedAccountIds(userId: string): Promise<string[]> {
    const rows = await prisma.mailAccount.findMany({ where: { userId }, select: { id: true } });
    return rows.map((row) => row.id);
}

/**
 * The mailboxes that feed the merged views.
 *
 * Separate from `ownedAccountIds` because the two answer different questions and
 * conflating them is what made the "in the shared inbox" switch do nothing: a
 * merged list is only the mailboxes somebody put in it, while a view that names
 * one mailbox has to open it whatever that switch says, or taking a mailbox out
 * of the merged views would make it unreachable.
 */
export async function unifiedAccountIds(userId: string): Promise<string[]> {
    const rows = await prisma.mailAccount.findMany({
        where: { userId, unified: true },
        select: { id: true }
    });
    return rows.map((row) => row.id);
}

/**
 * One folder, if the mailbox it is in is this person's.
 *
 * Narrowed by the owner in the same query rather than fetched and then checked:
 * a folder id is guessable in exactly the way a mailbox id is, and a check that
 * is a separate statement is a check that can be skipped by the next caller.
 */
export async function ownedFolder(userId: string, folderId: string) {
    const folder = await prisma.mailFolder.findFirst({
        where: { id: folderId, account: { userId } },
        select: { id: true, accountId: true, path: true, delimiter: true, name: true, role: true }
    });
    if (!folder) throw new MailAccessError("That folder is not yours.");
    return folder;
}

/** The messages out of a set that belong to this person, with what is needed to
 *  act on them. Silently drops any that do not, so one wrong id in a bulk
 *  action does not fail the other four hundred. */
export function ownedMessages(userId: string, messageIds: readonly string[]) {
    return prisma.mailMessage.findMany({
        where: { id: { in: [...messageIds] }, account: { userId } },
        select: {
            id: true,
            uid: true,
            accountId: true,
            folderId: true,
            threadId: true,
            messageId: true,
            seen: true,
            flagged: true
        }
    });
}
