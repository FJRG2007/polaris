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
import { clientIp } from "@/lib/request-context";
import { notifySecurityChange } from "@/lib/notifications/security-events";

export interface AuditEvent {
    readonly actorId: string | null;
    readonly action: string;
    readonly targetType?: string;
    readonly targetId?: string;
    readonly metadata?: Record<string, unknown>;
    /** The session the action came from. Resolved from the request when omitted. */
    readonly sessionId?: string;
    /**
     * The organization the action was about, when it was about one.
     *
     * This is the whole of what makes an organization's history its own: the same
     * table carries what somebody did to their account and what they did to a
     * company's roster, and only this tells the two apart. An action that changes
     * an organization and does not carry the id is one that organization can
     * never see happened.
     */
    readonly orgId?: string;
}

/**
 * Truncated SHA-256 of an address, as this log stores it.
 *
 * Exported because the hash is one-way: the only way to ask what was done from a
 * given address is to hash that address the same way and match, and a second copy
 * of this line would stop agreeing with this one the day either moved.
 */
export function auditIpHash(ip: string): string {
    return createHash("sha256").update(ip).digest("hex").slice(0, 16);
}

/** Truncated SHA-256 of the client IP, or undefined when unknown. Read through
 *  the same helper the rest of Polaris resolves an address with, so an entry is
 *  hashed from the address every other subsystem saw. */
async function clientIpHash(): Promise<string | undefined> {
    const ip = await clientIp();
    return ip ? auditIpHash(ip) : undefined;
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

/**
 * Record one activity event. Never throws - auditing must not break the action.
 *
 * An entry that describes a change to how an account is protected also raises
 * that account's security alert. It is hung here rather than on each screen
 * because the two questions have one answer: an action worth writing to the log
 * is an action the account owner should be told about, and a control that logs
 * but never tells is exactly the one somebody taking an account over would use.
 * Which actions those are is decided in notifications/security-events.
 */
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
                sessionId: event.sessionId ?? (await requestSessionId()),
                orgId: event.orgId ?? null
            }
        });
    } catch {
        // Swallow: a failed audit write must not fail the user's action.
    }
    try {
        await notifySecurityChange(event.actorId, event.action);
    } catch (error) {
        // Same rule: telling somebody about the change is never worth failing it.
        console.error("polaris: could not raise the account security alert:", error);
    }
}

/** Recent activity for the admin view, newest first. */
export async function listActivity(limit = 100) {
    return prisma.auditLog.findMany({
        orderBy: { at: "desc" },
        take: limit,
        select: {
            id: true,
            actorId: true,
            action: true,
            targetType: true,
            targetId: true,
            metadata: true,
            at: true
        }
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
    const actorIds = [
        ...new Set(events.map((event) => event.actorId).filter((id): id is string => Boolean(id)))
    ];
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
        select: {
            id: true,
            action: true,
            targetType: true,
            targetId: true,
            metadata: true,
            sessionId: true,
            at: true
        }
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

// ---------------------------------------------------------------------------
// One organization's history
// ---------------------------------------------------------------------------

/** One row of an organization's history. Unlike a personal entry this names who
 *  did it, because that is the question a group is actually asking. */
export interface OrgActivityEntry {
    id: string;
    /** ISO 8601; the screen formats it with the reader's own preferences. */
    at: string;
    /** The account behind it, or "Polaris" when nothing signed in did it. */
    actorId: string | null;
    actorName: string;
    action: string;
    /** The raw metadata document, or "" when the entry carried none. */
    metadata: string;
}

/**
 * What has been done to one organization, newest first, optionally narrowed to
 * one person.
 *
 * Scoped by `orgId` and nothing else, which is what keeps this from leaking a
 * member's personal history into a place their colleagues can read. An entry is
 * here because the action changed the organization - its roster, its teams, its
 * roles, its domains, its work - and never because the person who took it happens
 * to belong to it.
 */
export async function listOrgActivity(
    orgId: string,
    { actorId, limit = 200 }: { actorId?: string; limit?: number } = {}
): Promise<OrgActivityEntry[]> {
    const rows = await prisma.auditLog.findMany({
        where: { orgId, ...(actorId ? { actorId } : {}) },
        orderBy: { at: "desc" },
        take: limit,
        select: { id: true, actorId: true, action: true, metadata: true, at: true }
    });

    const actorIds = [...new Set(rows.map((row) => row.actorId).filter((id): id is string => Boolean(id)))];
    const actors =
        actorIds.length === 0
            ? []
            : await prisma.user.findMany({
                  where: { id: { in: actorIds } },
                  select: { id: true, name: true, email: true }
              });
    const nameById = new Map(actors.map((actor) => [actor.id, actor.name || actor.email]));

    return rows.map((row) => ({
        id: row.id,
        at: row.at.toISOString(),
        actorId: row.actorId,
        // Somebody who has since left, or whose account is gone, still has to
        // read as somebody - dropping the entry is the one thing an audit trail
        // may never do.
        actorName: row.actorId ? (nameById.get(row.actorId) ?? "a former member") : "Polaris",
        action: row.action,
        metadata: row.metadata ?? ""
    }));
}

/** The people who appear in an organization's history, for the filter to offer.
 *  Grouped in the database because the feed is capped, and somebody whose entries
 *  have scrolled past the cap is exactly who a reader is looking for. */
export async function listOrgActivityActors(orgId: string): Promise<{ id: string; name: string }[]> {
    const groups = await prisma.auditLog.groupBy({ by: ["actorId"], where: { orgId }, _max: { at: true } });
    const ids = groups.map((group) => group.actorId).filter((id): id is string => Boolean(id));
    if (ids.length === 0) return [];
    const actors = await prisma.user.findMany({
        where: { id: { in: ids } },
        select: { id: true, name: true, email: true }
    });
    return actors
        .map((actor) => ({ id: actor.id, name: actor.name || actor.email }))
        .sort((left, right) => left.name.localeCompare(right.name));
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
        .map((group) => ({
            id: group.sessionId,
            lastAt: (group._max.at ?? new Date(0)).toISOString()
        }))
        .sort((a, b) => b.lastAt.localeCompare(a.lastAt));
}
