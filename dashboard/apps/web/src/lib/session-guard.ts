/**
 * The per-request verdict on a session: may it be used right now, and if not,
 * where does the user go? Everything a user configures under Account > Security
 * that can stop a request is decided here, in one place, so no protected surface
 * can accidentally skip a control.
 *
 * The checks run in order of severity - a banned account or an expired session
 * ends the session outright, a refused location or a denied approval ends it too,
 * an idle timeout only locks it. State lives in SessionState (Polaris-owned)
 * because better-auth owns the Session row's columns.
 *
 * Cost matters: this runs on every authenticated request. The common path is one
 * query for the user plus their settings and this session's state, and a write
 * only when the activity stamp has gone stale.
 *
 * The same verdict is also applied out of band, once, when the rules themselves
 * change (revokeSessionsRefusedByRules) - a session sitting at an address it has
 * been at all along is not re-judged per request, so something has to re-judge
 * it the moment the rules underneath it move.
 */

import { prisma } from "@polaris/db";
import { recordAudit } from "@/lib/audit-service";
import { notify } from "@/lib/notifications/dispatch";
import type { ViewAsRow } from "@/lib/view-as-service";
import { describeOrigin } from "@/lib/session-directory";
import { evaluateAccountAccess } from "@/lib/network-rules";
import { getInstanceSecurity } from "@/lib/instance-security";
import { notifySessionOpened, notifySessionsClosed } from "@/lib/notifications/session-events";
import { consumeSessionRotation, rememberAccountDevice, resolveSignInRules, takeSignInRecord } from "@polaris/auth";
import {
    clientHost,
    clientIp,
    clientUserAgent,
    clientUserAgentBrands,
    clientUserAgentPlatform
} from "@/lib/request-context";

/**
 * Where a refused session is sent, or - when it may proceed - whether it is
 * currently looking at Polaris as somebody else. The view rides along with the
 * verdict because the row it lives on is one this function already reads: an
 * administrator viewing an account must not cost every request a second query.
 */
export type SessionVerdict = { ok: true; view: ViewAsRow } | { ok: false; redirect: string };

/** A session that is simply itself. */
const ALLOWED: SessionVerdict = {
    ok: true,
    view: { viewAsUserId: null, viewAsRoleId: null, viewAsAt: null }
};

/** How stale the activity stamp may get before it is worth a write. */
export const ACTIVITY_WRITE_INTERVAL_MS = 60_000;

interface GuardInput {
    userId: string;
    sessionId: string;
    /** When the session was issued, for the absolute-lifetime check. */
    sessionCreatedAt: Date;
}

/** End a session for good: the row is what the cookie is validated against. */
async function revokeSession(sessionId: string): Promise<void> {
    await prisma.session.deleteMany({ where: { id: sessionId } });
}

/**
 * End the sessions that a change to an account's network rules now refuses, and
 * leave every other one running. Narrowing where an account may connect from is
 * not a reason to sign it out of the places the new rules still allow: ending
 * them all logged people out of the very machine they had just been restricted
 * to, which is the one session the change was never meant to touch.
 *
 * Each session is judged on the address it was last seen at, so what survives is
 * what the new rules would let in anyway. Addresses repeat across one person's
 * sessions - a laptop and a phone behind one router - so a verdict is computed
 * once per distinct address, which keeps the geolocation lookups to one each.
 *
 * A session Polaris has never guarded has no recorded address and is left alone:
 * guardSession evaluates it in full the first time it serves a request.
 */
/**
 * Record that a signed-in person was here, from a page the guard does not run on.
 *
 * The dashboard stamps activity through guardSession, so a public page - a drop
 * point, a share - left an account looking untouched for days while its owner was
 * demonstrably using Polaris. The directory reads that stamp to say who was last
 * here, and it was wrong by whole days.
 *
 * Only for a real page load. It must not be called from a heartbeat: the idle lock
 * measures the same stamp, and a poll from a tab nobody is sitting at would hold an
 * unattended session open forever. The write is throttled by the same interval the
 * guard uses, in the WHERE clause, so calling it on every render costs one
 * no-op statement.
 */
export async function noteActivity(sessionId: string | undefined | null): Promise<void> {
    if (!sessionId) return;
    await prisma.sessionState
        .updateMany({
            where: {
                sessionId,
                lastSeenAt: { lt: new Date(Date.now() - ACTIVITY_WRITE_INTERVAL_MS) }
            },
            data: { lastSeenAt: new Date() }
        })
        .catch(() => undefined);
}

export async function revokeSessionsRefusedByRules(userId: string): Promise<number> {
    const states = await prisma.sessionState.findMany({
        where: { userId, session: { expiresAt: { gt: new Date() } } },
        select: { sessionId: true, ip: true }
    });
    if (states.length === 0) return 0;

    const ownRules = await resolveSignInRules(userId);
    const verdicts = new Map<string | null, boolean>();
    const refused: string[] = [];
    for (const state of states) {
        let allowed = verdicts.get(state.ip);
        if (allowed === undefined) {
            allowed = (await evaluateAccountAccess(userId, state.ip ?? undefined, ownRules)).allowed;
            verdicts.set(state.ip, allowed);
        }
        if (!allowed) refused.push(state.sessionId);
    }
    if (refused.length === 0) return 0;

    const { count } = await prisma.session.deleteMany({ where: { userId, id: { in: refused } } });
    await notifySessionsClosed({
        userId,
        count,
        reason: "Your sign-in rules no longer allow the addresses they were at."
    });
    return count;
}

/** Where an account with no second factor is sent to arm one. */
export const ENROLL_PATH = "/oauth/enroll";

/**
 * The instance's own demand, as a verdict: an account carrying no second factor
 * on a deployment that requires one goes to the step that arms one, and nowhere
 * else.
 *
 * Read from the record the guard already has rather than from a second query, and
 * only consulted for an account that has no factor - so a deployment that requires
 * one costs nothing extra for everybody who already complies, which after the
 * first week is everybody.
 *
 * Retroactive by construction: it asks what the account carries now, not when the
 * account was made, so an instance that turns the requirement on meets every
 * existing account at its next request.
 */
async function secondFactorVerdict(hasFactor: boolean): Promise<SessionVerdict | null> {
    if (hasFactor) return null;
    const { requireSecondFactor } = await getInstanceSecurity();
    return requireSecondFactor ? { ok: false, redirect: ENROLL_PATH } : null;
}

/**
 * Decide whether a session may serve this request, creating its Polaris-side
 * state on first sight. Callers redirect on a refusal; the pages that handle a
 * refusal (the lock, approval and enrollment screens) must not call this, or they
 * would bounce forever.
 */
export async function guardSession({
    userId,
    sessionId,
    sessionCreatedAt
}: GuardInput): Promise<SessionVerdict> {
    const [record, state] = await Promise.all([
        prisma.user.findUnique({
            where: { id: userId },
            select: {
                bannedAt: true,
                // The other way a sign-in proves itself. The approval gate stands
                // in for a second factor rather than stacking on top of one.
                twoFactorEnabled: true,
                security: {
                    select: {
                        idleLockMinutes: true,
                        sessionMaxMinutes: true,
                        requireLoginApproval: true
                    }
                }
            }
        }),
        prisma.sessionState.findUnique({ where: { sessionId } })
    ]);

    if (!record) return { ok: false, redirect: "/oauth/login" };
    if (record.bannedAt) {
        await revokeSession(sessionId);
        return { ok: false, redirect: "/oauth/login?banned=1" };
    }

    const settings = record.security;
    const now = Date.now();

    // 1. Absolute lifetime. A session past its ceiling is over, not locked:
    //    the user signs in again with their password.
    if (settings && settings.sessionMaxMinutes > 0) {
        const expiresAt = sessionCreatedAt.getTime() + settings.sessionMaxMinutes * 60_000;
        if (now >= expiresAt) {
            await revokeSession(sessionId);
            return { ok: false, redirect: "/oauth/login?expired=1" };
        }
    }

    const ip = await clientIp();

    // 2. First sight of this session, or a move to a new address: re-run the
    //    account's network rules rather than trusting an old verdict forever.
    if (!state || state.ip !== (ip ?? null)) {
        const decision = await evaluateAccountAccess(userId, ip, await resolveSignInRules(userId));
        if (!decision.allowed) {
            await revokeSession(sessionId);
            await recordAudit({
                actorId: userId,
                action: "account.signin.blocked",
                targetType: "session",
                targetId: sessionId,
                metadata: { reason: decision.reason }
            });
            return { ok: false, redirect: "/oauth/login?blocked=1" };
        }
        if (!state) {
            const created = await createSessionState({
                userId,
                sessionId,
                ip,
                country: decision.country,
                requireApproval:
                    settings?.requireLoginApproval === true && record.twoFactorEnabled !== true
            });
            if (created.approval === "pending") return { ok: false, redirect: "/oauth/pending" };
            // The session is real from here, so it faces the same demand every
            // later request faces. Returning early without asking would let one
            // request through per sign-in, which is one more than none.
            return (await secondFactorVerdict(record.twoFactorEnabled === true)) ?? ALLOWED;
        }
        await prisma.sessionState.update({
            where: { sessionId },
            data: { ip: ip ?? null, country: decision.country }
        });
    }

    // 3. An explicit decision from another session wins over everything below.
    if (state.approval === "denied") {
        await revokeSession(sessionId);
        return { ok: false, redirect: "/oauth/login?denied=1" };
    }
    if (state.approval === "pending") return { ok: false, redirect: "/oauth/pending" };

    // 4. The idle lock. Already locked, or idle long enough to lock now.
    if (state.lockedAt) return { ok: false, redirect: "/oauth/lock" };
    const idleMinutes = settings?.idleLockMinutes ?? 0;
    if (idleMinutes > 0 && now - state.lastSeenAt.getTime() >= idleMinutes * 60_000) {
        await prisma.sessionState.update({ where: { sessionId }, data: { lockedAt: new Date() } });
        return { ok: false, redirect: "/oauth/lock" };
    }

    // 5. The instance's demand for a second factor. After the lock, because a
    //    locked screen is the same person needing to prove themselves and asking
    //    them to arm a factor through it would be asking the wrong question first.
    const owed = await secondFactorVerdict(record.twoFactorEnabled === true);
    if (owed) return owed;

    // 6. Keep the activity stamp fresh, but not on every single request. A
    //    session opened before the host was recorded adopts it here, which is the
    //    only way an already-open one ever gets a name against it.
    const host = state.host ?? (await clientHost()) ?? null;
    if (host !== state.host || now - state.lastSeenAt.getTime() >= ACTIVITY_WRITE_INTERVAL_MS) {
        await prisma.sessionState
            .update({ where: { sessionId }, data: { lastSeenAt: new Date(), host } })
            .catch(() => undefined);
    }

    return { ok: true, view: state };
}

/**
 * Record a newly seen session. It starts pending only when the user asked for
 * approvals AND there is another live, approved session that could grant one -
 * otherwise the requirement would strand them with no way in.
 *
 * An account with an authenticator armed is never held: the sign-in already
 * answered a challenge, and asking a second session to allow it as well would
 * gate one sign-in twice for one proof of identity. Which of the two an account
 * uses is its own choice, made in Account > Security.
 *
 * A session that continues an approved one is exempt: better-auth replaces the
 * session when an authenticator is armed or removed, and the replacement is the
 * same person on the same device. The session being replaced leaves a
 * single-use, address-bound pass behind for it (see beginSessionRotation).
 *
 * This is also where the sign-in that opened the session is collected. The sign-in
 * itself happened in an earlier request - two earlier requests when a second
 * factor was answered - so what each of them proved was left on the account and
 * is picked up here, once, and written against the session it belongs to.
 *
 * A single navigation resolves the session more than once (the layout and the
 * page render concurrently), so two callers can reach this at the same moment for
 * the same brand-new session. The loser of that race adopts the row the winner
 * wrote rather than failing the request, and only the winner announces it.
 */
async function createSessionState(input: {
    userId: string;
    sessionId: string;
    ip: string | undefined;
    country: string | null;
    requireApproval: boolean;
}): Promise<{ approval: string }> {
    let approval = "approved";
    if (input.requireApproval && !(await consumeSessionRotation(input.userId, input.ip ?? null))) {
        const approver = await prisma.sessionState.findFirst({
            where: {
                userId: input.userId,
                approval: "approved",
                sessionId: { not: input.sessionId },
                session: { expiresAt: { gt: new Date() } }
            },
            select: { sessionId: true }
        });
        if (approver) approval = "pending";
    }

    const [userAgent, userAgentBrands, userAgentPlatform, host, signIn] = await Promise.all([
        clientUserAgent(),
        clientUserAgentBrands(),
        clientUserAgentPlatform(),
        clientHost(),
        takeSignInRecord(input.userId)
    ]);
    try {
        await prisma.sessionState.create({
            data: {
                sessionId: input.sessionId,
                userId: input.userId,
                approval,
                ip: input.ip ?? null,
                country: input.country,
                userAgent: userAgent ?? null,
                userAgentBrands: userAgentBrands ?? null,
                userAgentPlatform: userAgentPlatform ?? null,
                host: host ?? null,
                signInMethod: signIn.method,
                secondFactor: signIn.secondFactor,
                // Set only for a sign-in somebody else had to answer for - a
                // scanned code. The other way in that needs an answer, the
                // approval on Account > Sessions, comes after this row exists
                // and writes itself onto it there.
                authorizedBySessionId: signIn.authorizedBy?.sessionId ?? null,
                authorizedByDevice: signIn.authorizedBy?.device ?? null
            }
        });
    } catch {
        const existing = await prisma.sessionState.findUnique({
            where: { sessionId: input.sessionId },
            select: { approval: true }
        });
        // No row means the insert failed for a reason other than the race (a
        // session deleted mid-request, say); refuse rather than guess.
        return { approval: existing?.approval ?? "denied" };
    }

    // The account's register of the browsers it has ever been signed in from,
    // which is what dates a device for the new-device wait. Written here because
    // this runs exactly once per session, at the sign-in that opened it.
    await rememberAccountDevice(input.userId, {
        userAgent,
        userAgentBrands,
        userAgentPlatform,
        ip: input.ip,
        host
    });

    // The session carries this too, but a session ends and this does not: it is
    // what lets somebody read back how their account was signed into last month.
    await recordAudit({
        actorId: input.userId,
        action: "account.signin",
        targetType: "session",
        targetId: input.sessionId,
        sessionId: input.sessionId,
        metadata: {
            method: signIn.method,
            secondFactor: signIn.secondFactor,
            // Named in the log as well as on the session: the session ends, this
            // does not, and "which of my devices let that one in" is a question
            // asked long after the answer has been signed out.
            ...(signIn.authorizedBy ? { authorizedBy: signIn.authorizedBy.device } : {})
        }
    });

    if (approval === "pending") {
        await recordAudit({
            actorId: input.userId,
            action: "account.signin.awaiting-approval",
            targetType: "session",
            targetId: input.sessionId
        });
        await notify({
            userId: input.userId,
            event: "account.signin",
            title: "A new sign-in is waiting for your approval",
            body: describeOrigin(input.ip, input.country, userAgent, userAgentBrands, userAgentPlatform),
            href: "/account/sessions",
            actionRequired: true
        });
    } else {
        // Only for a session that can actually be used. One still waiting has its
        // own alert above, and announcing it twice would report a sign-in that
        // has not happened yet as one that has.
        await notifySessionOpened({
            userId: input.userId,
            origin: describeOrigin(input.ip, input.country, userAgent, userAgentBrands, userAgentPlatform)
        });
    }
    return { approval };
}
