/**
 * The mailboxes an organization hands out.
 *
 * What this is for, in the words it was asked for in: a company gives somebody
 * their work address and puts them on the support mailbox, and both should be
 * waiting for them when they switch the header to that company - without the
 * person having to know an IMAP host, and without those mailboxes being mixed in
 * with their own.
 *
 * **Handing one out writes an ordinary mailbox belonging to that person.** The
 * row's `userId` is the holder and its `orgId` says whose work it is part of.
 * There is no shared row, no second reader, and no path from running an
 * organization to reading its people's mail - the rule at the top of `access.ts`
 * is unchanged, and this file is careful never to select a message, a folder or
 * a credential.
 *
 * What somebody with `mail.manage` can see is the register: which addresses have
 * been handed out, who holds each one, and whether it is still connecting. That
 * last one is the reason this screen exists at all rather than being a one-time
 * setup form - a company mailbox whose password was rotated stops working
 * silently, and the person holding it often assumes it is meant to be like that.
 *
 * Taking one back removes the row and everything cached under it. It does not
 * touch the mailbox on the mail server, which is not Polaris' to touch: what is
 * revoked is this Polaris' copy of it and the credential it was reached with.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { addAccount } from "./accounts";
import { recordAudit } from "@/lib/audit-service";
import { orgIdsWhere } from "@/lib/orgs/org-service";

/** Raised when somebody asks to run an organization's mailboxes and may not. */
export class OrgMailboxError extends Error {
    public constructor(message = "That is not yours to do.") {
        super(message);
        this.name = "OrgMailboxError";
    }
}

/** Refuse unless this account runs the organization's mailboxes. */
export async function requireMailManager(actorId: string, orgId: string): Promise<void> {
    const running = await orgIdsWhere({ id: actorId, isAdmin: false }, "mail.manage");
    if (!running.includes(orgId)) throw new OrgMailboxError();
}

/** One row of the register. Deliberately nothing about what is inside. */
export interface OrgMailboxView {
    readonly id: string;
    readonly address: string;
    /** What the rail calls it for its holder, or "". */
    readonly label: string;
    readonly holderId: string;
    readonly holderName: string;
    /** "ok" | "auth" | "unreachable" | "never" - whether it is still connecting,
     *  which is the one thing about a handed-out mailbox that goes wrong on its
     *  own and is never noticed. */
    readonly state: string;
    readonly stateDetail: string;
    readonly lastSyncAt: string | null;
    readonly createdAt: string;
}

/** Every mailbox this organization has handed out, newest last. */
export async function listOrgMailboxes(actorId: string, orgId: string): Promise<OrgMailboxView[]> {
    await requireMailManager(actorId, orgId);
    const rows = await prisma.mailAccount.findMany({
        where: { orgId },
        orderBy: [{ createdAt: "asc" }],
        select: {
            id: true,
            address: true,
            label: true,
            state: true,
            stateDetail: true,
            lastSyncAt: true,
            createdAt: true,
            user: { select: { id: true, name: true, username: true } }
        }
    });
    return rows.map((row) => ({
        id: row.id,
        address: row.address,
        label: row.label,
        holderId: row.user.id,
        // The name, falling back to the handle. Never the address: this screen is
        // about the mailbox's address, and printing somebody's own beside it is
        // handing out a second one nobody asked about.
        holderName: row.user.name || `@${row.user.username ?? ""}`,
        state: row.state,
        stateDetail: row.stateDetail,
        lastSyncAt: row.lastSyncAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString()
    }));
}

/**
 * Give one to somebody on the roster.
 *
 * The holder is checked against the roster in the same statement that finds
 * them, so a crafted request cannot name an account that is not in this
 * organization - which would be handing a stranger a working mailbox and, worse,
 * a mailbox this organization then believes it controls.
 */
export async function handOutMailbox(
    actorId: string,
    orgId: string,
    holderId: string,
    setup: core.MailAccountSetup
): Promise<OrgMailboxView[]> {
    await requireMailManager(actorId, orgId);

    const onRoster = await prisma.organization.findFirst({
        where: {
            id: orgId,
            OR: [{ ownerId: holderId }, { members: { some: { userId: holderId } } }]
        },
        select: { id: true }
    });
    if (!onRoster) throw new OrgMailboxError("That person is not in this organization.");

    await addAccount(holderId, setup, orgId, actorId);
    return listOrgMailboxes(actorId, orgId);
}

/**
 * Take one back.
 *
 * Narrowed by the organization in the same query rather than found and then
 * checked: an id belonging to somebody's personal mailbox is exactly as
 * guessable as one belonging to this organization's, and the difference between
 * the two is somebody's own mail being deleted by their employer.
 */
export async function takeBackMailbox(
    actorId: string,
    orgId: string,
    accountId: string
): Promise<OrgMailboxView[]> {
    await requireMailManager(actorId, orgId);
    const row = await prisma.mailAccount.findFirst({
        where: { id: accountId, orgId },
        select: { id: true, address: true, userId: true }
    });
    if (!row) throw new OrgMailboxError("That mailbox is not this organization's.");

    // The row and everything cached under it - the folders, threads, messages and
    // the stored credential all cascade from it. The mailbox on the mail server
    // is untouched, which is right: it is the company's account with a provider,
    // not Polaris' to close.
    await prisma.mailAccount.delete({ where: { id: row.id } });

    await recordAudit({
        actorId,
        action: "mail.account.revoke",
        targetType: "mail-account",
        targetId: row.id,
        metadata: { address: row.address, orgId, from: row.userId }
    });
    return listOrgMailboxes(actorId, orgId);
}
