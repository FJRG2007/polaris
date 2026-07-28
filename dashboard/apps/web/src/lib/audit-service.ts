/**
 * Global activity log. Every meaningful action a user takes - connecting a NAS,
 * reading or writing a file, managing containers, inviting people - is recorded
 * here so operators have one auditable history across all of Polaris. The client
 * IP is stored hashed for privacy while still supporting abuse review; the
 * payload never includes secrets.
 *
 * Each entry also remembers the session it came from, which is what lets a user
 * read their own history one device at a time from the session list.
 */

import { createHash } from "node:crypto";
import { cache } from "react";
import { headers } from "next/headers";
import { prisma } from "@polaris/db";
import { auth } from "@/lib/auth";

export interface AuditEvent {
    readonly actorId: string | null;
    readonly action: string;
    readonly targetType?: string;
    readonly targetId?: string;
    readonly metadata?: Record<string, unknown>;
    /** The session the action came from. Resolved from the request when omitted. */
    readonly sessionId?: string;
}

/** Truncated SHA-256 of the client IP, or undefined when unknown. */
async function clientIpHash(): Promise<string | undefined> {
    const store = await headers();
    const forwarded = store.get("x-forwarded-for")?.split(",")[0]?.trim();
    const ip = forwarded || store.get("x-real-ip") || undefined;
    if (!ip) return undefined;
    return createHash("sha256").update(ip).digest("hex").slice(0, 16);
}

/**
 * The session this request arrived on, or undefined for anything not driven by a
 * browser session (API keys, background work). Memoized per request so several
 * audit writes in one action do not each re-resolve the cookie.
 */
const requestSessionId = cache(async (): Promise<string | undefined> => {
    try {
        const session = await auth.api.getSession({ headers: await headers() });
        return session?.session?.id;
    } catch {
        return undefined;
    }
});

/** Record one activity event. Never throws - auditing must not break the action. */
export async function recordAudit(event: AuditEvent): Promise<void> {
    try {
        await prisma.auditLog.create({
            data: {
                actorId: event.actorId,
                action: event.action,
                targetType: event.targetType,
                targetId: event.targetId,
                metadata: event.metadata ? JSON.stringify(event.metadata) : null,
                ipHash: await clientIpHash(),
                sessionId: event.sessionId ?? (await requestSessionId())
            }
        });
    } catch {
        // Swallow: a failed audit write must not fail the user's action.
    }
}

/** Recent activity for the admin view, newest first. */
export async function listActivity(limit = 100) {
    return prisma.auditLog.findMany({
        orderBy: { at: "desc" },
        take: limit,
        select: { id: true, actorId: true, action: true, targetType: true, targetId: true, metadata: true, at: true }
    });
}

export interface SessionActivityEntry {
    id: string;
    action: string;
    target: string | null;
    at: string;
}

/**
 * One session's own history, newest first. Always scoped by the owning user as
 * well as the session, so a session id belonging to another account reads back
 * as empty rather than as somebody else's activity.
 */
export async function listSessionActivity(
    userId: string,
    sessionId: string,
    limit = 100
): Promise<SessionActivityEntry[]> {
    const rows = await prisma.auditLog.findMany({
        where: { actorId: userId, sessionId },
        orderBy: { at: "desc" },
        take: limit,
        select: { id: true, action: true, targetType: true, targetId: true, at: true }
    });
    return rows.map((row) => ({
        id: row.id,
        action: row.action,
        target: row.targetType ? [row.targetType, row.targetId].filter(Boolean).join(" ") : null,
        at: row.at.toISOString()
    }));
}
