/**
 * What the screen reads: the faults a project has, and one of them in full.
 *
 * The list is the product, so it is one query plus one for the sparklines rather
 * than a query per row - a project with three hundred open issues is a normal
 * project, and a screen that costs three hundred round trips is a screen nobody
 * opens twice.
 *
 * Authorization is not here. Every function takes a project id that
 * `requireProject` has already allowed, so there is one place that answers "may
 * they" and it is not this file.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";

/** One fault, as the list draws it. */
export interface IssueRow {
    readonly id: string;
    readonly title: string;
    readonly type: string;
    readonly culprit: string;
    readonly level: string;
    readonly status: string;
    readonly timesSeen: number;
    readonly firstSeen: string;
    readonly lastSeen: string;
    readonly lastRelease: string | null;
    /** How many times a day over the window, oldest first, for the sparkline. */
    readonly daily: readonly number[];
}

/** One occurrence, in full. */
export interface EventDetail {
    readonly id: string;
    readonly eventId: string | null;
    readonly level: string;
    readonly message: string;
    readonly culprit: string;
    readonly release: string | null;
    readonly environment: string | null;
    readonly serverName: string | null;
    readonly transaction: string | null;
    readonly url: string | null;
    readonly method: string | null;
    readonly userLabel: string | null;
    readonly at: string;
    readonly frames: readonly core.StackFrame[];
    readonly breadcrumbs: readonly core.Breadcrumb[];
    readonly tags: Readonly<Record<string, string>>;
    readonly platform: string | null;
}

export interface IssueDetail extends IssueRow {
    /** How many separate occurrences are still stored, which is not `timesSeen`:
     *  that counts every one there has ever been, and these are the ones whose
     *  detail survived the project's retention. */
    readonly kept: number;
    readonly environments: readonly string[];
    readonly releases: readonly string[];
    readonly latest: EventDetail | null;
}

/** How far back a list and its sparklines look. */
export const TELEMETRY_WINDOW_DAYS = 30;

function midnight(at: Date): Date {
    return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

/** The days of the window, oldest first, so a sparkline can be filled by index
 *  and a day with nothing in it is a zero rather than a gap. */
function windowDays(now: Date, days: number): string[] {
    const end = midnight(now).getTime();
    return Array.from({ length: days }, (_, at) =>
        new Date(end - (days - 1 - at) * 86_400_000).toISOString().slice(0, 10)
    );
}

/**
 * The faults in a project.
 *
 * Ordered by when each was last seen, because the question somebody opens this
 * screen with is "what is happening now" - not "what has happened most", which
 * is a report and is one column away.
 */
export async function listIssues(
    projectId: string,
    filter: { status?: string; query?: string; environment?: string | null; now?: Date } = {}
): Promise<IssueRow[]> {
    const now = filter.now ?? new Date();
    const term = filter.query?.trim();

    const issues = await prisma.telemetryIssue.findMany({
        where: {
            projectId,
            ...(filter.status && filter.status !== "all" ? { status: filter.status } : {}),
            // One `contains` over the title, which is what somebody types when
            // they are looking for a fault they have seen before. Case-sensitive
            // on SQLite and not worth branching for: the title starts with the
            // exception's class, and nobody searches for "typeerror".
            ...(term ? { title: { contains: term } } : {}),
            ...(filter.environment ? { events: { some: { environment: filter.environment } } } : {})
        },
        orderBy: { lastSeen: "desc" },
        take: 200,
        select: {
            id: true,
            title: true,
            type: true,
            culprit: true,
            level: true,
            status: true,
            timesSeen: true,
            firstSeen: true,
            lastSeen: true,
            lastRelease: true
        }
    });
    if (issues.length === 0) return [];

    const days = windowDays(now, TELEMETRY_WINDOW_DAYS);
    const since = new Date(`${days[0]!}T00:00:00.000Z`);
    const counts = await prisma.telemetryDay.findMany({
        where: { issueId: { in: issues.map((issue) => issue.id) }, day: { gte: since } },
        select: { issueId: true, day: true, count: true }
    });

    const byIssue = new Map<string, Map<string, number>>();
    for (const row of counts) {
        const key = row.day.toISOString().slice(0, 10);
        const bucket = byIssue.get(row.issueId) ?? new Map<string, number>();
        bucket.set(key, (bucket.get(key) ?? 0) + row.count);
        byIssue.set(row.issueId, bucket);
    }

    return issues.map((issue) => ({
        ...issue,
        firstSeen: issue.firstSeen.toISOString(),
        lastSeen: issue.lastSeen.toISOString(),
        daily: days.map((day) => byIssue.get(issue.id)?.get(day) ?? 0)
    }));
}

/** How many of each status there are, for the tabs - counted rather than
 *  inferred from the list, which is capped. */
export async function issueCounts(projectId: string): Promise<Record<string, number>> {
    const rows = await prisma.telemetryIssue.groupBy({
        by: ["status"],
        where: { projectId },
        _count: { _all: true }
    });
    const counts: Record<string, number> = { unresolved: 0, resolved: 0, ignored: 0 };
    for (const row of rows) counts[row.status] = row._count._all;
    return counts;
}

function detailOf(event: {
    id: string;
    eventId: string | null;
    level: string;
    message: string;
    culprit: string;
    release: string | null;
    environment: string | null;
    serverName: string | null;
    transaction: string | null;
    url: string | null;
    method: string | null;
    userLabel: string | null;
    detail: string;
    at: Date;
}): EventDetail {
    let parsed: {
        frames?: core.StackFrame[];
        breadcrumbs?: core.Breadcrumb[];
        tags?: Record<string, string>;
        platform?: string | null;
    } = {};
    try {
        parsed = JSON.parse(event.detail) as typeof parsed;
    } catch {
        // A row written by a version that stored something else, or a truncated
        // one. The columns beside it are still worth showing.
    }
    return {
        ...event,
        at: event.at.toISOString(),
        frames: parsed.frames ?? [],
        breadcrumbs: parsed.breadcrumbs ?? [],
        tags: parsed.tags ?? {},
        platform: parsed.platform ?? null
    };
}

/** One fault in full, with its most recent occurrence. */
export async function getIssue(
    projectId: string,
    issueId: string,
    now: Date = new Date()
): Promise<IssueDetail | null> {
    const issue = await prisma.telemetryIssue.findFirst({
        where: { id: issueId, projectId },
        select: {
            id: true,
            title: true,
            type: true,
            culprit: true,
            level: true,
            status: true,
            timesSeen: true,
            firstSeen: true,
            lastSeen: true,
            lastRelease: true
        }
    });
    if (!issue) return null;

    const days = windowDays(now, TELEMETRY_WINDOW_DAYS);
    const since = new Date(`${days[0]!}T00:00:00.000Z`);
    const [counts, latest, kept, spread] = await Promise.all([
        prisma.telemetryDay.findMany({
            where: { issueId, day: { gte: since } },
            select: { day: true, count: true }
        }),
        prisma.telemetryEvent.findFirst({
            where: { issueId },
            orderBy: { at: "desc" },
            select: {
                id: true,
                eventId: true,
                level: true,
                message: true,
                culprit: true,
                release: true,
                environment: true,
                serverName: true,
                transaction: true,
                url: true,
                method: true,
                userLabel: true,
                detail: true,
                at: true
            }
        }),
        prisma.telemetryEvent.count({ where: { issueId } }),
        prisma.telemetryEvent.findMany({
            where: { issueId },
            distinct: ["environment", "release"],
            take: 50,
            select: { environment: true, release: true }
        })
    ]);

    const byDay = new Map(counts.map((row) => [row.day.toISOString().slice(0, 10), row.count]));
    return {
        ...issue,
        firstSeen: issue.firstSeen.toISOString(),
        lastSeen: issue.lastSeen.toISOString(),
        daily: days.map((day) => byDay.get(day) ?? 0),
        kept,
        environments: [...new Set(spread.map((row) => row.environment).filter((row): row is string => Boolean(row)))],
        releases: [...new Set(spread.map((row) => row.release).filter((row): row is string => Boolean(row)))],
        latest: latest ? detailOf(latest) : null
    };
}

/**
 * Change what an issue is doing.
 *
 * Resolving records the release it was resolved in, which is what lets the same
 * fault arriving from a later build reopen itself: without it, "resolved" would
 * mean "somebody clicked this once" forever.
 */
export async function setIssueStatus(
    projectId: string,
    issueId: string,
    status: core.TelemetryStatus,
    by: string
): Promise<void> {
    const issue = await prisma.telemetryIssue.findFirst({
        where: { id: issueId, projectId },
        select: { lastRelease: true }
    });
    if (!issue) return;
    await prisma.telemetryIssue.updateMany({
        where: { id: issueId, projectId },
        data:
            status === "resolved"
                ? {
                      status,
                      resolvedAt: new Date(),
                      resolvedById: by,
                      resolvedInRelease: issue.lastRelease
                  }
                : { status, resolvedAt: null, resolvedById: null, resolvedInRelease: null }
    });
}

/** Remove a fault and everything under it. What this is for is a fault that was
 *  a mistake in the reporting rather than in the code - a debug event, a test
 *  crash - and it is a delete because keeping those is what makes a list stop
 *  being read. */
export async function deleteIssue(projectId: string, issueId: string): Promise<void> {
    await prisma.telemetryIssue.deleteMany({ where: { id: issueId, projectId } });
}

/** Every occurrence still stored for one fault, newest first. */
export async function listEvents(issueId: string, take = 25): Promise<EventDetail[]> {
    const rows = await prisma.telemetryEvent.findMany({
        where: { issueId },
        orderBy: { at: "desc" },
        take,
        select: {
            id: true,
            eventId: true,
            level: true,
            message: true,
            culprit: true,
            release: true,
            environment: true,
            serverName: true,
            transaction: true,
            url: true,
            method: true,
            userLabel: true,
            detail: true,
            at: true
        }
    });
    return rows.map(detailOf);
}
