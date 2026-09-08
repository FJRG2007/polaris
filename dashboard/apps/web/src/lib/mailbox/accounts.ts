/**
 * Adding, changing and removing a mailbox.
 *
 * The rule that shapes this file: **nothing is stored until the server has
 * accepted it.** A mailbox row that does not work is worse than no row at all -
 * it sits in the rail failing quietly, and the person who added it has already
 * moved on and will not connect the two. So both servers are tried with the
 * credential first, and a refusal comes back as a message on the form beside the
 * field that caused it.
 *
 * The second rule: the credential exists in one shape here and one only. It
 * arrives, it is tried, it is sealed, and the plain text is never written
 * anywhere - not into a log line, not into an audit entry, not into the object
 * a screen is handed.
 */

import { checkSmtp } from "./send";
import { checkImap } from "./imap";
import { prisma } from "@polaris/db";
import { syncAccount } from "./sync";
import * as core from "@polaris/core";
import { MailAuthError } from "./credentials";
import { recordAudit } from "@/lib/audit-service";
import { ownedAccount, ownedAccounts } from "./access";
import { grantsMailAccess, sealMailSecret } from "./credentials";

/** What a screen may know about a mailbox. Never the credential, and never the
 *  server's own words about an internal failure. */
export interface MailAccountView {
    readonly id: string;
    readonly address: string;
    readonly displayName: string;
    readonly label: string;
    readonly color: string | null;
    readonly service: string;
    readonly serviceName: string;
    readonly auth: "password" | "oauth";
    readonly imapHost: string;
    readonly imapPort: number;
    readonly smtpHost: string;
    readonly smtpPort: number;
    readonly state: string;
    readonly stateDetail: string;
    readonly lastSyncAt: string | null;
    readonly notify: boolean;
    readonly unified: boolean;
    readonly appendToSent: boolean;
    readonly signature: string;
    readonly signatureAboveQuote: boolean;
    readonly remoteContent: string;
    readonly nameTrackers: boolean;
    readonly answerReceipts: boolean;
    readonly cleanLinks: boolean;
    readonly signatureAuto: string;
    readonly securityKeepMinutes: number;
    readonly vacationEnabled: boolean;
    readonly pollSeconds: number;
    readonly position: number;
}

type AccountRow = Awaited<ReturnType<typeof ownedAccount>>;

export function accountView(row: AccountRow): MailAccountView {
    return {
        id: row.id,
        address: row.address,
        displayName: row.displayName,
        label: row.label,
        color: row.color,
        service: row.service,
        serviceName: core.findMailService(row.service)?.name ?? "",
        auth: row.auth === "oauth" ? "oauth" : "password",
        imapHost: row.imapHost,
        imapPort: row.imapPort,
        smtpHost: row.smtpHost,
        smtpPort: row.smtpPort,
        state: row.state,
        stateDetail: row.stateDetail,
        lastSyncAt: row.lastSyncAt?.toISOString() ?? null,
        notify: row.notify,
        unified: row.unified,
        appendToSent: row.appendToSent,
        signature: row.signature,
        signatureAboveQuote: row.signatureAboveQuote,
        remoteContent: row.remoteContent,
        nameTrackers: row.nameTrackers,
        answerReceipts: row.answerReceipts,
        cleanLinks: row.cleanLinks,
        signatureAuto: row.signatureAuto,
        securityKeepMinutes: row.securityKeepMinutes,
        vacationEnabled: row.vacationEnabled,
        pollSeconds: row.pollSeconds,
        position: row.position
    };
}

export async function listAccountViews(
    userId: string,
    shelfOrgId: string | null
): Promise<MailAccountView[]> {
    return (await ownedAccounts(userId, shelfOrgId)).map(accountView);
}

/** Raised when a mailbox cannot be added for a reason the person can fix, with
 *  the sentence to put on the form. */
export class MailSetupError extends Error {
    /** The field to point at, where one field is at fault. */
    public readonly field: string;

    public constructor(message: string, field = "") {
        super(message);
        this.name = "MailSetupError";
        this.field = field;
    }
}

/**
 * Add a mailbox.
 *
 * The order is deliberate. The address is claimed first, because two rows for
 * one mailbox is a mess that shows up as duplicated mail rather than as an
 * error. Then IMAP, because it is the one that fails - a wrong password fails
 * here, and failing on IMAP is a sentence about the password rather than about
 * sending. Then SMTP, which fails separately often enough (a provider that
 * allows reading and blocks sending) to be worth its own message.
 */
export async function addAccount(
    userId: string,
    setup: core.MailAccountSetup,
    /** Whose work the mailbox is part of, and therefore which shelf it appears
     *  on. Null is somebody's own. */
    orgId: string | null,
    /** Who is doing it, when that is not the person it is for - an organization
     *  handing out the company address. Only the audit line differs: the mailbox
     *  that comes out belongs to `userId` and to nobody else. */
    byId: string = userId
): Promise<MailAccountView> {
    const existing = await prisma.mailAccount.findFirst({
        where: { userId, address: setup.address },
        select: { id: true }
    });
    if (existing) throw new MailSetupError("That mailbox is already here.", "address");

    const service = setup.provider ? core.findMailService(setup.provider) : null;
    const connectionId = setup.auth === "oauth" ? await usableConnection(userId, setup) : null;

    const sealed =
        setup.auth === "password" && setup.password ? sealMailSecret(setup.password) : null;
    const candidate = {
        address: setup.address,
        username: setup.username,
        auth: setup.auth,
        service: service?.slug ?? "",
        connectionId,
        encryptedSecret: sealed?.encryptedSecret ?? null,
        secretNonce: sealed?.secretNonce ?? null,
        secretKeyId: sealed?.secretKeyId ?? null,
        imapHost: setup.imap.host,
        imapPort: setup.imap.port,
        imapSecurity: setup.imap.security,
        smtpHost: setup.smtp.host,
        smtpPort: setup.smtp.port,
        smtpSecurity: setup.smtp.security
    };

    await tryServer(() => checkImap(candidate), "imapHost");
    await tryServer(() => checkSmtp(candidate), "smtpHost");

    const last = await prisma.mailAccount.findFirst({
        where: { userId, orgId },
        orderBy: { position: "desc" },
        select: { position: true }
    });

    const created = await prisma.mailAccount.create({
        data: {
            userId,
            orgId,
            ...candidate,
            displayName: setup.displayName,
            label: setup.label,
            // A service that files its own copy into Sent must not have a second
            // one appended, or everything sent is there twice. Decided here from
            // what the service is, and its owner can still change it.
            appendToSent: !service?.sentIsAutomatic,
            state: "ok",
            lastOkAt: new Date(),
            position: (last?.position ?? -1) + 1
        },
        select: { id: true }
    });

    await recordAudit({
        actorId: byId,
        action: "mail.account.add",
        targetType: "mail-account",
        targetId: created.id,
        // The address and how it was authorized. Never the credential, and never
        // the host, which is derivable from the address and is nobody's business
        // in an audit log they did not ask for. `for` appears only when somebody
        // else did this, which is the whole point of recording it.
        metadata: {
            address: setup.address,
            auth: setup.auth,
            ...(orgId ? { orgId } : {}),
            ...(byId === userId ? {} : { for: userId })
        }
    });

    // The first sync runs behind the redirect rather than in front of it: a
    // large mailbox takes minutes, and a form that waits for it is a form
    // somebody thinks has hung. What they see is the mailbox, syncing.
    void syncAccount(created.id).catch(() => undefined);

    return accountView(await ownedAccount(userId, created.id));
}

/**
 * The linked account authorizing an OAuth mailbox, checked before anything is
 * stored.
 *
 * Two ways this fails and both are worth their own sentence: the link is gone or
 * belongs to somebody else, and the link exists but was granted for the calendar
 * rather than the mailbox. The second is the common one, because somebody who
 * connected Google months ago has a link that reaches everything except their
 * mail, and "authorize it again" is the only thing that fixes it.
 */
async function usableConnection(userId: string, setup: core.MailAccountSetup): Promise<string> {
    if (!setup.connectionId)
        throw new MailSetupError(
            "Choose the account that authorizes this mailbox.",
            "connectionId"
        );
    const link = await prisma.userConnection.findFirst({
        where: { id: setup.connectionId, userId },
        select: { id: true, provider: true, scope: true }
    });
    if (!link)
        throw new MailSetupError(
            "That authorized account is not linked here any more.",
            "connectionId"
        );
    if (!grantsMailAccess(link.provider, link.scope)) {
        throw new MailSetupError(
            "That account is linked, but it has not been given access to its mail. Authorize it again from here.",
            "connectionId"
        );
    }
    return link.id;
}

/** Run one server check and turn its refusal into a message on a field. */
async function tryServer(check: () => Promise<void>, field: string): Promise<void> {
    try {
        await check();
    } catch (caught) {
        if (caught instanceof MailAuthError) {
            throw new MailSetupError(caught.message, field === "imapHost" ? "password" : field);
        }
        throw new MailSetupError(
            field === "imapHost"
                ? "Polaris could not reach the incoming server. Check the name and the port."
                : "Polaris could not reach the outgoing server. Check the name and the port.",
            field
        );
    }
}

/** What can be changed about a mailbox without reconnecting it. */
export async function editAccount(
    userId: string,
    accountId: string,
    edit: {
        displayName: string;
        label: string;
        color: string | null;
        notify: boolean;
        pollSeconds: number;
        unified: boolean;
        appendToSent: boolean;
        signature: string;
        signatureAboveQuote: boolean;
    }
): Promise<MailAccountView> {
    await ownedAccount(userId, accountId);
    await prisma.mailAccount.update({ where: { id: accountId }, data: edit });
    return accountView(await ownedAccount(userId, accountId));
}

/** The privacy switches, which are per mailbox because a work one and a
 *  personal one are not the same decision. */
export async function setAccountPrivacy(
    userId: string,
    accountId: string,
    privacy: core.MailPrivacy
): Promise<MailAccountView> {
    await ownedAccount(userId, accountId);
    await prisma.mailAccount.update({ where: { id: accountId }, data: privacy });
    return accountView(await ownedAccount(userId, accountId));
}

/** The out-of-office reply. Turning it on clears who has already been answered,
 *  so a second holiday does not stay silent to everybody who wrote during the
 *  first one. */
export async function setVacation(
    userId: string,
    accountId: string,
    vacation: {
        enabled: boolean;
        subject: string;
        body: string;
        startsAt: Date | null;
        endsAt: Date | null;
        repeatDays: number;
    }
): Promise<MailAccountView> {
    const account = await ownedAccount(userId, accountId);
    await prisma.$transaction(async (tx) => {
        await tx.mailAccount.update({
            where: { id: accountId },
            data: {
                vacationEnabled: vacation.enabled,
                vacationSubject: vacation.subject,
                vacationBody: vacation.body,
                vacationStartsAt: vacation.startsAt,
                vacationEndsAt: vacation.endsAt,
                vacationRepeatDays: vacation.repeatDays
            }
        });
        if (vacation.enabled && !account.vacationEnabled) {
            await tx.mailAutoReply.deleteMany({ where: { accountId } });
        }
    });
    return accountView(await ownedAccount(userId, accountId));
}

/**
 * Take a mailbox off Polaris.
 *
 * Everything cached goes with it, which is the whole of what is deleted: the
 * mail itself is on the server and is not touched. Said plainly on the screen
 * that asks, because "remove mailbox" reads like "delete my mail" to anybody who
 * has not thought about where it lives.
 */
export async function removeAccount(userId: string, accountId: string): Promise<void> {
    const account = await ownedAccount(userId, accountId);
    await prisma.mailAccount.delete({ where: { id: accountId } });
    await recordAudit({
        actorId: userId,
        action: "mail.account.remove",
        targetType: "mail-account",
        targetId: accountId,
        metadata: { address: account.address }
    });
}

/** Reorder the rail. The whole list is sent rather than the move, the way the
 *  chat rail does it: a reorder that arrives as one statement cannot land
 *  half-applied. */
export async function reorderAccounts(
    userId: string,
    shelfOrgId: string | null,
    orderedIds: readonly string[]
): Promise<void> {
    // One shelf's rail at a time, which is the only rail anybody can drag.
    const mine = new Set((await ownedAccounts(userId, shelfOrgId)).map((account) => account.id));
    const wanted = orderedIds.filter((id) => mine.has(id));
    await prisma.$transaction(
        wanted.map((id, index) =>
            prisma.mailAccount.update({ where: { id }, data: { position: index } })
        )
    );
}

/** Write down what the last conversation with the server came to, so the rail
 *  can say so without asking again. */
export async function recordAccountState(
    accountId: string,
    state: "ok" | "auth" | "unreachable",
    detail = ""
): Promise<void> {
    await prisma.mailAccount.update({
        where: { id: accountId },
        data: {
            state,
            stateDetail: detail,
            lastSyncAt: new Date(),
            ...(state === "ok" ? { lastOkAt: new Date() } : {})
        }
    });
}
