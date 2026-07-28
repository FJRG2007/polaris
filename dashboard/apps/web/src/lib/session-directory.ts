/**
 * The user's own session list: what is signed in, from where, and what to do
 * about it. Every read and write is scoped by the owning user, so one account can
 * never see or end another's sessions.
 *
 * Device names come from the stored user-agent. That string is client-supplied
 * and can say anything, so it is only ever used as a label - never as an input to
 * a decision - and is rendered as a short summary rather than echoed raw.
 */

import { verifyQuickPin } from "@polaris/auth";
import { prisma } from "@polaris/db";
import { auth } from "@/lib/auth";
import { recordAudit } from "@/lib/audit-service";

export interface SessionView {
    id: string;
    /** Whether this is the session making the request. */
    current: boolean;
    approval: "approved" | "pending" | "denied";
    locked: boolean;
    device: string;
    ip: string | null;
    country: string | null;
    lastSeenAt: string;
    createdAt: string;
    expiresAt: string;
}

/** A readable device label from a user-agent string. */
export function describeDevice(userAgent: string | null | undefined): string {
    if (!userAgent) return "Unknown device";
    const browser =
        /\bEdg\//.test(userAgent) ? "Edge"
        : /\bOPR\//.test(userAgent) ? "Opera"
        : /\bFirefox\//.test(userAgent) ? "Firefox"
        : /\bChrome\//.test(userAgent) ? "Chrome"
        : /\bSafari\//.test(userAgent) ? "Safari"
        : "Browser";
    const platform =
        /Windows/.test(userAgent) ? "Windows"
        : /Android/.test(userAgent) ? "Android"
        : /iPhone|iPad|iOS/.test(userAgent) ? "iOS"
        : /Mac OS X|Macintosh/.test(userAgent) ? "macOS"
        : /Linux/.test(userAgent) ? "Linux"
        : "Unknown OS";
    return `${browser} on ${platform}`;
}

/** One line describing where a sign-in came from, for a notification body. */
export function describeOrigin(
    ip: string | undefined | null,
    country: string | null,
    userAgent: string | undefined | null
): string {
    const where = [ip || null, country].filter(Boolean).join(" - ");
    return where ? `${describeDevice(userAgent)} - ${where}` : describeDevice(userAgent);
}

const APPROVALS: ReadonlySet<string> = new Set(["approved", "pending", "denied"]);

/** Every live session for a user, newest first, with the current one flagged. */
export async function listUserSessions(userId: string, currentSessionId: string): Promise<SessionView[]> {
    const rows = await prisma.session.findMany({
        where: { userId, expiresAt: { gt: new Date() } },
        orderBy: { createdAt: "desc" },
        select: {
            id: true,
            createdAt: true,
            expiresAt: true,
            ipAddress: true,
            userAgent: true,
            state: true
        }
    });
    return rows.map((row) => {
        const approval = row.state?.approval ?? "approved";
        return {
            id: row.id,
            current: row.id === currentSessionId,
            approval: (APPROVALS.has(approval) ? approval : "approved") as SessionView["approval"],
            locked: row.state?.lockedAt != null,
            device: describeDevice(row.state?.userAgent ?? row.userAgent),
            ip: row.state?.ip ?? row.ipAddress,
            country: row.state?.country ?? null,
            lastSeenAt: (row.state?.lastSeenAt ?? row.createdAt).toISOString(),
            createdAt: row.createdAt.toISOString(),
            expiresAt: row.expiresAt.toISOString()
        };
    });
}

/** End one of the caller's own sessions. */
export async function revokeUserSession(userId: string, sessionId: string): Promise<void> {
    const result = await prisma.session.deleteMany({ where: { id: sessionId, userId } });
    if (result.count > 0) {
        await recordAudit({ actorId: userId, action: "account.session.revoked", targetType: "session", targetId: sessionId });
    }
}

/** End every session except the caller's own. Returns how many were ended. */
export async function revokeOtherSessions(userId: string, currentSessionId: string): Promise<number> {
    const result = await prisma.session.deleteMany({ where: { userId, id: { not: currentSessionId } } });
    if (result.count > 0) {
        await recordAudit({
            actorId: userId,
            action: "account.session.revoked-others",
            metadata: { count: result.count }
        });
    }
    return result.count;
}

/**
 * Approve or refuse a pending sign-in from an already-trusted session. A refusal
 * ends the waiting session immediately rather than leaving it parked, so a
 * rejected attempt holds nothing.
 *
 * Letting somebody in is the direction that needs proof, so it asks for the
 * quick-unlock PIN - an open dashboard someone walked up to should not be enough.
 * Refusing needs no PIN: it only ever closes a door.
 */
export async function decideLoginApproval(
    userId: string,
    sessionId: string,
    approve: boolean,
    pin?: string
): Promise<{ error?: string }> {
    const state = await prisma.sessionState.findFirst({
        where: { sessionId, userId, approval: "pending" },
        select: { sessionId: true }
    });
    if (!state) return { error: "That sign-in is no longer waiting." };

    if (approve) {
        if (!(await verifyQuickPin(auth, userId, String(pin ?? "")))) {
            return { error: "That PIN is not right." };
        }
        await prisma.sessionState.update({
            where: { sessionId },
            data: { approval: "approved", lastSeenAt: new Date() }
        });
    } else {
        await prisma.session.deleteMany({ where: { id: sessionId, userId } });
    }
    await recordAudit({
        actorId: userId,
        action: approve ? "account.signin.approved" : "account.signin.denied",
        targetType: "session",
        targetId: sessionId
    });
    return {};
}
