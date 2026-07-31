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
 */

import { consumeSessionRotation, resolveSignInRules } from "@polaris/auth";
import { prisma } from "@polaris/db";
import { recordAudit } from "@/lib/audit-service";
import { clientIp, clientUserAgent } from "@/lib/request-context";
import { createNotification } from "@/lib/notification-service";
import { describeOrigin } from "@/lib/session-directory";
import { evaluateNetworkRules } from "@/lib/network-rules";

/** Where a refused session is sent, or null when the session may proceed. */
export type SessionVerdict = { ok: true } | { ok: false; redirect: string };

const ALLOWED: SessionVerdict = { ok: true };

/** How stale the activity stamp may get before it is worth a write. */
const ACTIVITY_WRITE_INTERVAL_MS = 60_000;

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
 * Decide whether a session may serve this request, creating its Polaris-side
 * state on first sight. Callers redirect on a refusal; the pages that handle a
 * refusal (the lock and approval screens) must not call this, or they would
 * bounce forever.
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
        const decision = await evaluateNetworkRules(await resolveSignInRules(userId), ip);
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
            return ALLOWED;
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

    // 5. Keep the activity stamp fresh, but not on every single request.
    if (now - state.lastSeenAt.getTime() >= ACTIVITY_WRITE_INTERVAL_MS) {
        await prisma.sessionState
            .update({ where: { sessionId }, data: { lastSeenAt: new Date() } })
            .catch(() => undefined);
    }

    return ALLOWED;
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

    const userAgent = await clientUserAgent();
    try {
        await prisma.sessionState.create({
            data: {
                sessionId: input.sessionId,
                userId: input.userId,
                approval,
                ip: input.ip ?? null,
                country: input.country,
                userAgent: userAgent ?? null
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

    if (approval === "pending") {
        await recordAudit({
            actorId: input.userId,
            action: "account.signin.awaiting-approval",
            targetType: "session",
            targetId: input.sessionId
        });
        await createNotification({
            userId: input.userId,
            type: "account.signin",
            title: "A new sign-in is waiting for your approval",
            body: describeOrigin(input.ip, input.country, userAgent),
            href: "/account/sessions",
            level: "warning",
            actionRequired: true
        });
    }
    return { approval };
}
