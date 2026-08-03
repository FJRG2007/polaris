/**
 * Global activity log. Every meaningful action a user takes - connecting a NAS,
 * reading or writing a file, managing containers, inviting people - is recorded
 * here so operators have one auditable history across all of Polaris. The client
 * IP is stored hashed for privacy while still supporting abuse review; the
 * payload never includes secrets.
 *
 * Each entry also remembers the session it came from, which is what lets a user
 * read their own history on its own screen and narrow it to one device.
 */

import { cache } from "react";
import { auth } from "@/lib/auth";
import { prisma } from "@polaris/db";
import { headers } from "next/headers";
import { createHash } from "node:crypto";

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

/** One row of the admin activity feed, ready to render. */
export interface ActivityEntry {
    id: string;
    /** ISO 8601; the screen formats it with the reader's own preferences. */
    at: string;
    /** The account behind the action, "system" when Polaris acted on its own. */
    actor: string;
    action: string;
    /** The raw metadata document, or "" when the entry carried none. */
    metadata: string;
}

/**
 * Recent activity with its actors resolved, newest first. The log stores an id,
 * so the names come from one further query rather than a join per row - and an
 * actor who has since been deleted reads as "unknown" instead of dropping the
 * entry, which is the whole point of an audit trail.
 */
export async function listActivityFeed(limit = 200): Promise<ActivityEntry[]> {
    const events = await listActivity(limit);
    const actorIds = [...new Set(events.map((event) => event.actorId).filter((id): id is string => Boolean(id)))];
    const actors =
        actorIds.length === 0
            ? []
            : await prisma.user.findMany({
                  where: { id: { in: actorIds } },
                  select: { id: true, name: true, email: true }
              });
    const nameById = new Map(actors.map((actor) => [actor.id, actor.name || actor.email]));
    return events.map((event) => ({
        id: event.id,
        at: event.at.toISOString(),
        actor: event.actorId ? (nameById.get(event.actorId) ?? "unknown") : "system",
        action: event.action,
        metadata: event.metadata ?? ""
    }));
}

/** One row of a user's own history, ready to render. */
export interface UserActivityEntry {
    id: string;
    /** ISO 8601; the screen formats it with the reader's own preferences. */
    at: string;
    action: string;
    /** What the action was aimed at, as one line, or "" when it named nothing. */
    target: string;
    /** The raw metadata document, or "" when the entry carried none. */
    metadata: string;
    /** The session it came from, null for anything a browser did not drive. */
    sessionId: string | null;
}

/** A session that appears in a user's history, for the filter to offer. */
export interface ActivitySessionGroup {
    /** Null groups everything that reached Polaris outside a browser session. */
    id: string | null;
    /** When that session was last heard from, so the list can be ordered. */
    lastAt: string;
}

/**
 * A user's own history, newest first, optionally narrowed to one session.
 *
 * Always scoped by the owning user, so a session id belonging to another account
 * reads back as empty rather than as somebody else's activity. `sessionId: null`
 * asks for the entries that came from no session at all - an API key, a
 * background job - which is exactly what a reader auditing their account wants to
 * be able to isolate.
 */
export async function listUserActivity(
    userId: string,
    { sessionId, limit = 200 }: { sessionId?: string | null; limit?: number } = {}
): Promise<UserActivityEntry[]> {
    const rows = await prisma.auditLog.findMany({
        where: { actorId: userId, ...(sessionId === undefined ? {} : { sessionId }) },
        orderBy: { at: "desc" },
        take: limit,
        select: { id: true, action: true, targetType: true, targetId: true, metadata: true, sessionId: true, at: true }
    });
    return rows.map((row) => ({
        id: row.id,
        at: row.at.toISOString(),
        action: row.action,
        target: row.targetType ? [row.targetType, row.targetId].filter(Boolean).join(" ") : "",
        metadata: row.metadata ?? "",
        sessionId: row.sessionId
    }));
}

/**
 * The sessions a user's history was written from, newest first.
 *
 * Grouped in the database rather than derived from the entries on screen: the
 * feed is capped, so a session whose activity has scrolled past the cap would
 * otherwise vanish from the filter that exists to bring it back.
 */
export async function listUserActivitySessions(userId: string): Promise<ActivitySessionGroup[]> {
    const groups = await prisma.auditLog.groupBy({
        by: ["sessionId"],
        where: { actorId: userId },
        _max: { at: true }
    });
    return groups
        .map((group) => ({ id: group.sessionId, lastAt: (group._max.at ?? new Date(0)).toISOString() }))
        .sort((a, b) => b.lastAt.localeCompare(a.lastAt));
}
