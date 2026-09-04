/**
 * Writing down what a program said when it broke.
 *
 * One function does the work, and everything that reports - an application's
 * Sentry client posting to the ingest route, and Polaris catching its own
 * exceptions in process - goes through it, so a crash looks the same on the
 * screen whichever way it arrived.
 *
 * Three writes per event and no more: the issue it belongs to, the event itself,
 * and the day's count. This runs on the path of a program that is already having
 * a bad day, and an ingest that is slow is an ingest that is dropped by the
 * client and blamed on the application.
 *
 * A regression is decided here rather than by a person. An issue somebody marked
 * resolved, seen again in a release that is not the one it was resolved in, is
 * open again and says so - that is the one thing a list of resolved issues is
 * for, and leaving it to be noticed is how a fixed bug quietly stops being fixed.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";

/** The project an event is being written into, as the caller resolved it. */
export interface IngestProject {
    readonly id: string;
    readonly platform: string | null;
}

/** Midnight UTC of the day an event happened on. One row per issue per day, and
 *  UTC rather than the reader's zone so a count never moves when somebody with a
 *  different clock opens the screen. */
function dayOf(at: Date): Date {
    return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

/**
 * Store one event.
 *
 * Never throws. Every caller is either a request that must still answer 200 - a
 * client that gets an error back retries, and a retry storm from a crashing
 * application is how an ingest takes the rest of the dashboard down with it - or
 * an exception handler, where throwing would replace the crash being reported
 * with a crash in the reporting.
 */
export async function captureEvent(project: IngestProject, event: core.CapturedEvent): Promise<void> {
    try {
        const title = core.titleOf(event);
        const existing = await prisma.telemetryIssue.findUnique({
            where: { projectId_fingerprint: { projectId: project.id, fingerprint: event.fingerprint } },
            select: { id: true, status: true, resolvedInRelease: true, lastSeen: true }
        });

        const issueId = existing
            ? await touchIssue(existing, event, title)
            : await openIssue(project.id, event, title);

        await prisma.telemetryEvent.create({
            data: {
                projectId: project.id,
                issueId,
                eventId: event.eventId,
                level: event.level,
                message: title,
                culprit: event.culprit,
                release: event.release,
                environment: event.environment,
                serverName: event.serverName,
                transaction: event.transaction,
                url: event.url,
                method: event.method,
                userLabel: event.user,
                detail: JSON.stringify({
                    frames: event.frames,
                    breadcrumbs: event.breadcrumbs,
                    tags: event.tags,
                    platform: event.platform
                }),
                at: event.at
            }
        });

        const day = dayOf(event.at);
        await prisma.telemetryDay.upsert({
            where: { issueId_day: { issueId, day } },
            create: { projectId: project.id, issueId, day, count: 1 },
            update: { count: { increment: 1 } }
        });

        // The first event names the platform, and nothing after it changes it: a
        // project reports from one runtime, and a stray browser event from a
        // server project should not relabel the whole thing.
        if (!project.platform && event.platform) {
            await prisma.telemetryProject
                .updateMany({ where: { id: project.id, platform: null }, data: { platform: event.platform } })
                .catch(() => undefined);
        }
    } catch (error) {
        console.error("polaris: could not store a telemetry event:", error);
    }
}

async function openIssue(projectId: string, event: core.CapturedEvent, title: string): Promise<string> {
    const issue = await prisma.telemetryIssue.upsert({
        // Two events of a brand-new fault can arrive at the same instant, which
        // on a crash loop is the normal case rather than the rare one. The loser
        // of that race adopts the row the winner wrote.
        where: { projectId_fingerprint: { projectId, fingerprint: event.fingerprint } },
        create: {
            projectId,
            fingerprint: event.fingerprint,
            type: event.type,
            title,
            culprit: event.culprit,
            level: event.level,
            firstSeen: event.at,
            lastSeen: event.at,
            lastRelease: event.release,
            timesSeen: 1
        },
        update: { timesSeen: { increment: 1 }, lastSeen: event.at },
        select: { id: true }
    });
    return issue.id;
}

async function touchIssue(
    existing: { id: string; status: string; resolvedInRelease: string | null; lastSeen: Date },
    event: core.CapturedEvent,
    title: string
): Promise<string> {
    // Seen again after being resolved. In the release it was resolved in it is
    // an event from before the fix shipped and is left alone; in any other, the
    // fix did not hold.
    const regressed =
        existing.status === "resolved" &&
        (existing.resolvedInRelease === null || existing.resolvedInRelease !== event.release);

    await prisma.telemetryIssue.update({
        where: { id: existing.id },
        data: {
            timesSeen: { increment: 1 },
            // Only ever forward: events arrive out of order, and an old one must
            // not drag "last seen" backwards.
            ...(event.at > existing.lastSeen
                ? { lastSeen: event.at, title, culprit: event.culprit, level: event.level }
                : {}),
            ...(event.release ? { lastRelease: event.release } : {}),
            ...(regressed ? { status: "unresolved", resolvedAt: null, resolvedInRelease: null } : {})
        }
    });
    return existing.id;
}

/**
 * Delete what a project no longer keeps.
 *
 * The events go and the daily counts stay, which is the whole point of keeping
 * them apart: a chart of a fault over three months is worth having long after
 * the individual stack traces stop being worth the disk. An issue nothing is
 * left of - no events, no counts, never resolved - goes too, so a project that
 * had one bad week does not carry the list forever.
 */
export async function pruneTelemetry(now: Date = new Date()): Promise<number> {
    const projects = await prisma.telemetryProject.findMany({
        select: { id: true, retentionDays: true }
    });
    let removed = 0;
    for (const project of projects) {
        const days = Math.max(1, project.retentionDays);
        const before = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
        const { count } = await prisma.telemetryEvent.deleteMany({
            where: { projectId: project.id, at: { lt: before } }
        });
        removed += count;
    }
    // A year of counts, which is longer than any project's events and short
    // enough that the table cannot grow without bound.
    const yearAgo = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
    await prisma.telemetryDay.deleteMany({ where: { day: { lt: yearAgo } } });
    return removed;
}
