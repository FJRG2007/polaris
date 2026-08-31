/**
 * Sending a status change back to the tracker it came from.
 *
 * The other direction, and the one people actually notice: somebody drags a card
 * on the Polaris board, or an agent moves the task it was given, and the issue in
 * Jira moves too. Without it a mirrored board is a read-only copy, which is worth
 * something and is not what "one place for the work" means.
 *
 * Deliberately importing nothing from the task layer. This is called BY it, on
 * the one path every status change goes through, and an import in the other
 * direction would be a cycle. Everything it needs it reads for itself.
 */

import { prisma } from "@polaris/db";
import { credentialFor } from "./service";
import { trackerClient } from "./providers";

/**
 * Push a task's new status, if it mirrors an issue and the connection was told to.
 *
 * Best effort and silent about success. It is called from inside a write that has
 * already happened, so a tracker that refused must not turn a status change that
 * worked into an error - what it does instead is leave the reason on the
 * connection, where the screen that owns it can say so.
 */
export async function pushTaskStatus(taskId: string): Promise<void> {
    const link = await prisma.taskTrackerLink.findUnique({
        where: { taskId },
        select: {
            id: true,
            issueId: true,
            issueKey: true,
            pushedStatus: true,
            trackerId: true,
            tracker: { select: { enabled: true, pushStatus: true } },
            task: { select: { status: { select: { name: true } } } }
        }
    });
    if (!link || !link.tracker.enabled || !link.tracker.pushStatus) return;

    const statusName = link.task.status?.name ?? "";
    // A task with no status says nothing about what the issue should be, and a
    // status Polaris itself last pushed is not a change worth sending back.
    if (!statusName || statusName === link.pushedStatus) return;

    const credential = await credentialFor(link.trackerId);
    if (!credential) return;

    try {
        await trackerClient(credential).setStatus(
            { id: link.issueId, key: link.issueKey },
            statusName
        );
        await prisma.taskTrackerLink.update({
            where: { id: link.id },
            // Both, and for different reasons. `pushedStatus` stops this pushing
            // the same thing twice; `remoteStatus` stops the next pull reading
            // Polaris's own write as a change and pushing it back.
            data: { pushedStatus: statusName, remoteStatus: statusName, syncedAt: new Date() }
        });
    } catch (error) {
        await prisma.taskTracker.update({
            where: { id: link.trackerId },
            data: {
                error: `${link.issueKey}: ${error instanceof Error ? error.message : "the tracker refused the change"}`
            }
        });
    }
}

/**
 * Leave a comment on the issue a task mirrors.
 *
 * Only what Polaris itself has to say - an agent finished, a deploy went out -
 * rather than every comment on the task. Mirroring a whole conversation in both
 * directions is how a thread ends up with each message in it twice.
 */
export async function commentOnIssue(taskId: string, body: string): Promise<void> {
    const link = await prisma.taskTrackerLink.findUnique({
        where: { taskId },
        select: {
            issueId: true,
            issueKey: true,
            trackerId: true,
            tracker: { select: { enabled: true } }
        }
    });
    if (!link?.tracker.enabled) return;
    const credential = await credentialFor(link.trackerId);
    if (!credential) return;
    await trackerClient(credential)
        .comment({ id: link.issueId, key: link.issueKey }, body)
        .catch(() => undefined);
}

/** Whether a task mirrors an issue, and which. Read by the screens that want to
 *  link out to it rather than pretend the task is the original. */
export async function issueForTask(
    taskId: string
): Promise<{ key: string; url: string; provider: string } | null> {
    const link = await prisma.taskTrackerLink.findUnique({
        where: { taskId },
        select: { issueKey: true, issueUrl: true, tracker: { select: { provider: true } } }
    });
    return link
        ? { key: link.issueKey, url: link.issueUrl, provider: link.tracker.provider }
        : null;
}
