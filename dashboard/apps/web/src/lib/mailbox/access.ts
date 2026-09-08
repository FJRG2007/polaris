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
 *
 * **A mailbox handed out by an organization does not bend that.** An
 * organization can provision one for somebody - the company address, the support
 * mailbox - and what that writes is an ordinary row belonging to that person,
 * with `orgId` naming whose work it is part of. Whoever runs the organization
 * can see the mailbox exists, who holds it and whether it is connecting, and can
 * take it back. There is no path from any of that to a message in it, and the
 * functions below are why: none of them will return a row for anybody but its
 * own `userId`.
 *
 * `orgId` narrows what is *listed*, never what is *allowed*. The listing
 * functions take the shelf because Mail draws one working life at a time - the
 * personal mailboxes or the company's - and the ones that resolve a named
 * mailbox, folder or message deliberately do not: the shelf is a switch in a
 * header, and an action fired as it flips must not be refused for it.
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
    orgId: true,
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
    signatureAuto: true,
    securityKeepMinutes: true,
    spamFilter: true,
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

/**
 * Which of this person's mailboxes belong to the shelf being worked from.
 *
 * Their own on the personal shelf, and one organization's on its own - never
 * both. Mixing them is the same mistake as a Drive that lists a client's files
 * beside holiday photos: a reply sent from the wrong address is not a thing
 * anybody notices before the recipient does.
 *
 * `undefined` is deliberately not accepted. Every lister here takes the shelf as
 * an argument that has to be written, because the failure of forgetting it is
 * silent - a screen that lists everything looks like a screen that works.
 */
function onShelf(userId: string, shelfOrgId: string | null) {
    return { userId, orgId: shelfOrgId };
}

/** Every mailbox this person has on this shelf, in rail order. */
export function ownedAccounts(userId: string, shelfOrgId: string | null) {
    return prisma.mailAccount.findMany({
        where: onShelf(userId, shelfOrgId),
        select: ACCOUNT_COLUMNS,
        orderBy: [{ position: "asc" }, { createdAt: "asc" }]
    });
}

/** The ids of them, for the queries that span all of them. */
export async function ownedAccountIds(userId: string, shelfOrgId: string | null): Promise<string[]> {
    const rows = await prisma.mailAccount.findMany({
        where: onShelf(userId, shelfOrgId),
        select: { id: true }
    });
    return rows.map((row) => row.id);
}

/**
 * Every mailbox this person has, whatever shelf it is on.
 *
 * For the two things that are not a screen: the background sync, which has to
 * poll a company mailbox whether or not its owner is currently looking at that
 * shelf, and the live stream, which decides whether a frame is even this
 * person's. Both would be wrong to narrow - mail arriving in a mailbox nobody is
 * looking at is exactly the mail somebody wants to be told about.
 *
 * Named so that using it is a decision. Anything drawing a list wants
 * `ownedAccountIds` and its shelf.
 */
export async function everyAccountId(userId: string): Promise<string[]> {
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
export async function unifiedAccountIds(
    userId: string,
    shelfOrgId: string | null
): Promise<string[]> {
    const rows = await prisma.mailAccount.findMany({
        where: { ...onShelf(userId, shelfOrgId), unified: true },
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
