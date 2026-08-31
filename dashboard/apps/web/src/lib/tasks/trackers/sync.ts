/**
 * Bringing a tracker's issues in, and keeping them right.
 *
 * A pull rather than a webhook. Both providers can push, and neither can push to
 * a Polaris that is not on the public internet - which most of them are not. A
 * poll works everywhere, needs nothing configured at either end, and the cost of
 * being a minute behind on somebody else's board is nothing.
 *
 * What is mirrored is deliberately small: the title, the description and the
 * status. Not the assignees, because the two systems have different people in
 * them and guessing which Polaris account is which Jira account is how somebody
 * ends up assigned to work they have never heard of. Not the comments, because a
 * conversation copied in two directions is a conversation that duplicates itself.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { trackerClient } from "./providers";
import * as tasks from "@/lib/tasks/task-service";
import { credentialFor, noteSync } from "./service";

export interface SyncResult {
    readonly added: number;
    readonly updated: number;
    readonly error: string | null;
}

/**
 * One pass over a connection.
 *
 * Never throws. A sync is run from a screen, from a schedule and from an action,
 * and every one of those wants the reason on the connection rather than an
 * exception to render.
 */
export async function syncTracker(trackerId: string): Promise<SyncResult> {
    const tracker = await prisma.taskTracker.findUnique({
        where: { id: trackerId },
        select: { id: true, ownerId: true, provider: true, spaceId: true, listId: true, enabled: true }
    });
    if (!tracker) return { added: 0, updated: 0, error: "That connection no longer exists." };
    if (!tracker.enabled) return { added: 0, updated: 0, error: null };
    if (!core.isIssueTracker(tracker.provider)) {
        return { added: 0, updated: 0, error: "This build does not know that tracker." };
    }
    // The same row with its provider narrowed to one this build knows, which the
    // guard above has just established and the column's type cannot say.
    const connection = { ...tracker, provider: tracker.provider };

    const credential = await credentialFor(trackerId);
    if (!credential) {
        const detail = "This connection has no key stored on it.";
        await noteSync(trackerId, detail);
        return { added: 0, updated: 0, error: detail };
    }

    let issues: core.TrackerIssue[];
    try {
        issues = await trackerClient(credential).issues();
    } catch (error) {
        const detail = error instanceof Error ? error.message : "The tracker did not answer.";
        await noteSync(trackerId, detail);
        return { added: 0, updated: 0, error: detail };
    }

    const statuses = await prisma.taskStatus.findMany({
        where: { spaceId: tracker.spaceId },
        select: { id: true, name: true, type: true },
        orderBy: { order: "asc" }
    });
    const links = await prisma.taskTrackerLink.findMany({
        where: { trackerId },
        select: { id: true, taskId: true, issueKey: true, remoteStatus: true }
    });
    const byKey = new Map(links.map((link) => [link.issueKey, link]));

    let added = 0;
    let updated = 0;
    let refused = "";

    for (const issue of issues) {
        try {
            const change = await applyIssue(connection, statuses, byKey.get(issue.key) ?? null, issue);
            if (change === "added") added += 1;
            if (change === "updated") updated += 1;
        } catch (error) {
            // One issue is not the pass. A description longer than a task can
            // hold, a title of control characters, a status that vanished - each
            // of those is one row of somebody else's data, and letting it throw
            // would stop this connection and, from the schedule, every connection
            // behind it. The first one is kept for the connection to show.
            if (!refused) {
                refused = `${issue.key}: ${error instanceof Error ? error.message : "Polaris could not mirror it."}`;
            }
        }
    }

    if (refused) {
        await noteSync(trackerId, refused);
        return { added, updated, error: refused };
    }

    await noteSync(trackerId, null);
    return { added, updated, error: null };
}

/** What one pass did to one issue. */
type IssueChange = "added" | "updated" | "unchanged";

/**
 * Mirror one issue, creating the task or moving the one that already mirrors it.
 *
 * Everything a provider hands over is clamped to what a task can hold before it
 * is parsed: the schema is Polaris's rule about its own rows, not a judgement
 * anybody can act on about somebody else's issue.
 */
async function applyIssue(
    tracker: { id: string; ownerId: string; provider: core.IssueTracker; spaceId: string; listId: string },
    statuses: readonly { id: string; name: string; type: string }[],
    existing: { id: string; taskId: string; remoteStatus: string } | null,
    issue: core.TrackerIssue
): Promise<IssueChange> {
    const statusId = statusFor(statuses, issue);

    if (!existing) {
        const created = await tasks.createTask(
            null,
            tracker.spaceId,
            core.taskCreateSchema.parse({
                listId: tracker.listId,
                name: core.linkedName(issue),
                description: core.linkedDescription(issue, tracker.provider),
                statusId
            })
        );
        await prisma.taskTrackerLink.create({
            data: {
                trackerId: tracker.id,
                taskId: created.id,
                issueKey: issue.key,
                issueId: issue.id,
                issueUrl: issue.url,
                remoteStatus: issue.status
            }
        });
        return "added";
    }

    // Only what actually moved. A pass that rewrote every task every minute
    // would fill the activity feed with changes nobody made and would fight
    // whoever is editing one right now.
    if (existing.remoteStatus === issue.status) return "unchanged";

    // Before the write, not after it. `updateTask` pushes a status change back to
    // the tracker it came from, and this change came FROM there: without this the
    // pull answers every remote move with a write into somebody else's issue,
    // which either fails or lands on a different state that the next pull reads
    // as another remote move.
    const target = statusId ? statuses.find((status) => status.id === statusId) : null;
    if (target) {
        await prisma.taskTrackerLink.update({
            where: { id: existing.id },
            data: { pushedStatus: target.name }
        });
    }

    // Acting as whoever connected the tracker. The change did come from
    // somewhere else, but an activity line has to name an account, and the
    // honest one is the person whose credential read the issue.
    await tasks.updateTask(tracker.ownerId, {
        taskId: existing.taskId,
        ...(statusId ? { statusId } : {})
    });
    await prisma.taskTrackerLink.update({
        where: { id: existing.id },
        data: { remoteStatus: issue.status, issueId: issue.id, issueUrl: issue.url, syncedAt: new Date() }
    });
    return "updated";
}

/**
 * The status in this space that an issue's state means.
 *
 * By name first, because a team that named their Polaris statuses after their
 * Jira ones meant that. By kind second, so a tracker whose states are named
 * nothing like ours still lands somewhere sensible rather than in whatever
 * column happens to be first.
 */
function statusFor(
    statuses: readonly { id: string; name: string; type: string }[],
    issue: core.TrackerIssue
): string | null {
    const flat = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, "");
    const wanted = flat(issue.status);
    const byName = statuses.find((status) => flat(status.name) === wanted);
    if (byName) return byName.id;
    const byType = statuses.find((status) => status.type === issue.statusType);
    return byType?.id ?? null;
}

/** Every connection due a pass, for the schedule. Disabled ones are skipped here
 *  rather than inside the sync, so a run says how many it actually looked at. */
export async function trackersToSync(): Promise<string[]> {
    const rows = await prisma.taskTracker.findMany({ where: { enabled: true }, select: { id: true } });
    return rows.map((row) => row.id);
}
