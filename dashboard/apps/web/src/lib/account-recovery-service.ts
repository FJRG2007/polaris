/**
 * Getting back into an account from outside it.
 *
 * This is the last way in, and it is deliberately the slowest. Everything faster
 * is already on the sign-in page: the password, a passkey, a code from the
 * authenticator or by text, a link to the mailbox. When none of those are left -
 * no channel to send through, no second device, nothing but the person and what
 * they remember - the only honest answer is that somebody who runs the instance
 * has to decide, so that is what this raises.
 *
 * The recovery questions are what the requester can put behind the request, not
 * what grants it. They are low-entropy by nature and answered from outside any
 * session, so treating them as proof would make them a second, weaker password.
 * They are checked, the result is recorded on the request, and the administrator
 * seeing the request is told which kind they are looking at. An account that
 * never set any can still ask, because that is exactly the case this exists for.
 *
 * What the requester keeps is a ticket: 256 bits held only by their browser,
 * stored here as a SHA-256 like every other link Polaris hands out. It carries no
 * authority of its own - it names a request, and only an approved request lets a
 * password through. It is spent on first use.
 *
 * The route answers the same way whether or not an account exists, so it cannot
 * be swept for registered addresses. The one thing it does disclose is that an
 * address has recovery questions set, which is the same trade the sign-in page
 * already makes for the passkey hint, and it is throttled per address and per
 * network for the same reason.
 */

import { auth } from "./auth";
import { prisma } from "@polaris/db";
import { recordAudit } from "./audit-service";
import { rateLimit } from "./rate-limit-service";
import { passwordIsBreached } from "./pwned-passwords";
import { revokeUserSessions } from "./user-admin-service";
import { notifyOperators } from "./notifications/operators";
import { generateToken, hashToken } from "@polaris/core/tokens";
import { listSecurityQuestions, resetUserPassword, verifySecurityAnswers } from "@polaris/auth";
import {
    BREACHED_PASSWORD_MESSAGE,
    IDENTITY_PASSWORD_MESSAGE,
    passwordMatchesIdentity,
    SECURITY_QUESTION_COUNT,
    type AccountRecoveryStatus
} from "@polaris/core";

/** How long a request stays on the administrators' list, and how long an approved
 *  one stays redeemable. A day covers a night's sleep and no more. */
const TICKET_TTL_MS = 24 * 60 * 60 * 1000;

/** Reading back an account's questions is what makes this route usable, and also
 *  the only thing on it worth probing. Generous for a person who mistyped their
 *  address, useless for walking a list. */
const LOOKUP_LIMIT = 10;
const LOOKUP_WINDOW_MS = 15 * 60 * 1000;

/** Raising a request is cheap for the requester and noisy for whoever decides it,
 *  so it is capped harder, and per network as well as per account. */
const REQUEST_LIMIT = 3;
const REQUEST_WINDOW_MS = 60 * 60 * 1000;

/** One waiting request, as the administrators' list renders it. */
export interface RecoveryRequestView {
    id: string;
    userName: string;
    userEmail: string;
    /** Whether the recovery questions were answered when it was raised. */
    verified: boolean;
    requestIp: string | null;
    createdAt: string;
    expiresAt: string;
}

/**
 * The account a typed identifier - an email or a username - can recover, or null.
 *
 * A banned account is not one of them: getting back in is not the question there,
 * and lifting the ban is the answer to the one that is. It reads as "no such
 * account" from outside, which is all a suspended account should say.
 */
async function findAccount(identifier: string): Promise<{ id: string } | null> {
    const value = identifier.trim().toLowerCase();
    const account = await prisma.user.findFirst({
        where: value.includes("@") ? { email: value } : { username: value },
        select: { id: true, bannedAt: true }
    });
    return account && account.bannedAt === null ? { id: account.id } : null;
}

/**
 * The questions a requester has to answer, if their account set any.
 *
 * An empty list is the answer for an account with no questions AND for an
 * identifier that matches nothing, so the page that calls this cannot be used to
 * tell those apart - both go on to raise a request the same way.
 */
export async function accountRecoveryQuestions(
    identifier: string,
    ip: string | null
): Promise<{ questions: string[]; retryAfterMs: number }> {
    const key = identifier.trim().toLowerCase();
    const [byAccount, byNetwork] = await Promise.all([
        rateLimit(`recovery-lookup:${key}`, LOOKUP_LIMIT, LOOKUP_WINDOW_MS),
        rateLimit(`recovery-lookup-ip:${ip ?? "unknown"}`, LOOKUP_LIMIT * 3, LOOKUP_WINDOW_MS)
    ]);
    if (!byAccount.ok || !byNetwork.ok) {
        return { questions: [], retryAfterMs: Math.max(byAccount.retryAfterMs, byNetwork.retryAfterMs) };
    }
    const account = await findAccount(identifier);
    if (!account) return { questions: [], retryAfterMs: 0 };
    const rows = await listSecurityQuestions(account.id);
    return { questions: rows.map((row) => row.question), retryAfterMs: 0 };
}

/**
 * Raise a request, and hand back the ticket that will redeem it.
 *
 * A ticket is issued whatever the identifier turned out to be. For one that
 * matches no account it names nothing and will never be approved, which is what
 * keeps the answer identical either way - the same stance the sign-in page takes
 * when it emails a link.
 */
export async function requestAccountRecovery(input: {
    identifier: string;
    answers: readonly string[];
    ip: string | null;
    userAgent: string | null;
}): Promise<{ ticket: string; error?: string }> {
    const key = input.identifier.trim().toLowerCase();
    const [byAccount, byNetwork] = await Promise.all([
        rateLimit(`recovery-request:${key}`, REQUEST_LIMIT, REQUEST_WINDOW_MS),
        rateLimit(`recovery-request-ip:${input.ip ?? "unknown"}`, REQUEST_LIMIT * 3, REQUEST_WINDOW_MS)
    ]);
    if (!byAccount.ok || !byNetwork.ok) {
        const wait = Math.ceil(Math.max(byAccount.retryAfterMs, byNetwork.retryAfterMs) / 60000);
        return { ticket: "", error: `Too many attempts. Try again in ${wait} minutes.` };
    }

    const ticket = generateToken();
    const account = await findAccount(input.identifier);
    if (!account) return { ticket };

    const userId = account.id;
    const verified =
        input.answers.length === SECURITY_QUESTION_COUNT &&
        (await verifySecurityAnswers(auth, userId, input.answers));

    // One undecided request per account: asking again replaces the one still
    // waiting, so a decision is always about the attempt in front of the
    // administrator rather than a queue of identical ones.
    //
    // A request that has already been approved is deliberately left alone. It
    // belongs to somebody who has been let back in and has not finished yet, and
    // anyone who knows their address could otherwise take that back by raising a
    // fresh request - turning this route into a way to keep a person locked out
    // rather than a way to get them in.
    await prisma.$transaction([
        prisma.accountRecovery.deleteMany({ where: { userId, status: "pending" } }),
        prisma.accountRecovery.create({
            data: {
                userId,
                tokenHash: hashToken(ticket),
                verified,
                requestIp: input.ip,
                expiresAt: new Date(Date.now() + TICKET_TTL_MS)
            }
        })
    ]);
    await recordAudit({
        actorId: userId,
        action: "account.recovery.requested",
        targetType: "user",
        targetId: userId,
        metadata: { verified, ip: input.ip, userAgent: input.userAgent }
    });
    await notifyOperators({
        permission: "users.manage",
        event: "account.recovery",
        title: "Someone is locked out of their account",
        body: verified
            ? "They answered their recovery questions. Approve it in People to let them set a new password."
            : "They could not answer any recovery questions. Check who they are before approving it in People.",
        href: "/admin/users",
        level: "warning",
        actionRequired: true
    });
    return { ticket };
}

/**
 * Where a ticket stands. An unknown ticket reads as pending rather than as an
 * error: the page polls this, and saying "no such request" would give away in one
 * call what the rest of the route is careful not to.
 */
export async function accountRecoveryStatus(ticket: string): Promise<AccountRecoveryStatus> {
    const row = await prisma.accountRecovery.findUnique({
        where: { tokenHash: hashToken(ticket) },
        select: { status: true, expiresAt: true }
    });
    if (!row) return "pending";
    if (row.status === "pending" && row.expiresAt.getTime() < Date.now()) return "expired";
    return row.status as AccountRecoveryStatus;
}

/**
 * Why this password cannot be the one, or null when it can.
 *
 * The identity comparison has to happen here rather than in the browser: the page
 * asking for the password is unauthenticated and is deliberately never told whose
 * account it is working on, so the server is the only side that holds both halves.
 * The breach check runs on both sides - the client's is for the person typing,
 * this one is the one that decides.
 */
async function unacceptablePassword(userId: string, password: string): Promise<string | null> {
    const account = await prisma.user.findUnique({
        where: { id: userId },
        select: { name: true, email: true, username: true }
    });
    if (passwordMatchesIdentity(password, [account?.name, account?.email, account?.username, "polaris"])) {
        return IDENTITY_PASSWORD_MESSAGE;
    }
    return (await passwordIsBreached(password)) ? BREACHED_PASSWORD_MESSAGE : null;
}

/**
 * Spend an approved request on a new password. Every session on the account goes
 * with it: whoever is being let back in has been locked out for a while, and
 * anything still signed in as them is the reason to be careful, not to be kind.
 */
export async function completeAccountRecovery(
    ticket: string,
    newPassword: string
): Promise<{ error?: string }> {
    const row = await prisma.accountRecovery.findUnique({ where: { tokenHash: hashToken(ticket) } });
    if (!row || row.status !== "approved") return { error: "That request is not approved." };
    if (row.expiresAt.getTime() < Date.now()) {
        await prisma.accountRecovery.update({ where: { id: row.id }, data: { status: "expired" } });
        return { error: "That request has expired. Start again from the sign-in page." };
    }

    const refusal = await unacceptablePassword(row.userId, newPassword);
    if (refusal) return { error: refusal };

    // Spend the ticket before writing anything, as a conditional write only one
    // caller can win: two submissions racing must not both get to set a password.
    const spent = await prisma.accountRecovery.updateMany({
        where: { id: row.id, status: "approved" },
        data: { status: "used" }
    });
    if (spent.count !== 1) return { error: "That request has already been used." };

    const result = await resetUserPassword(auth, row.userId, newPassword);
    if (result.error) {
        // Nothing was written, so the request is still there to be spent.
        await prisma.accountRecovery.updateMany({ where: { id: row.id }, data: { status: "approved" } });
        return result;
    }
    await revokeUserSessions(row.userId, row.userId);
    await recordAudit({
        actorId: row.userId,
        action: "account.recovery.completed",
        targetType: "user",
        targetId: row.userId
    });
    return {};
}

/** The requests waiting on a decision, oldest first - the person who has been
 *  locked out longest is the one to deal with first. */
export async function listRecoveryRequests(): Promise<RecoveryRequestView[]> {
    const rows = await prisma.accountRecovery.findMany({
        where: { status: "pending", expiresAt: { gt: new Date() } },
        orderBy: { createdAt: "asc" },
        take: 50,
        select: {
            id: true,
            verified: true,
            requestIp: true,
            createdAt: true,
            expiresAt: true,
            user: { select: { name: true, email: true } }
        }
    });
    return rows.map((row) => ({
        id: row.id,
        userName: row.user.name,
        userEmail: row.user.email,
        verified: row.verified,
        requestIp: row.requestIp,
        createdAt: row.createdAt.toISOString(),
        expiresAt: row.expiresAt.toISOString()
    }));
}

/**
 * Decide a waiting request. Approving does not set a password - it lets the
 * person holding the ticket set their own, which is the only version of this
 * where the administrator never learns what they chose.
 */
export async function decideRecoveryRequest(
    adminId: string,
    id: string,
    approve: boolean
): Promise<{ error?: string }> {
    const decided = await prisma.accountRecovery.updateMany({
        where: { id, status: "pending" },
        data: { status: approve ? "approved" : "denied", decidedById: adminId, decidedAt: new Date() }
    });
    if (decided.count === 0) return { error: "That request has already been decided." };
    const row = await prisma.accountRecovery.findUnique({ where: { id }, select: { userId: true } });
    await recordAudit({
        actorId: adminId,
        action: approve ? "account.recovery.approved" : "account.recovery.denied",
        targetType: "user",
        targetId: row?.userId ?? id
    });
    return {};
}
