/**
 * A server's history, its notes and who hears about it.
 *
 * The third reader of the shared tables, after Tasks and Deploy, and the one the
 * whole exercise was for: "this box drops its NAS mount every few weeks, do not
 * bother rebooting it" is knowledge that used to live in somebody's head or in a
 * task nobody could find from the server.
 *
 * Everything here is owner-checked against the Host on the way in - `system.manage`
 * says somebody may look after servers, not that they may look after THIS one, and
 * a subject id in a request proves nothing on its own.
 */

import { prisma } from "@polaris/db";
import * as follow from "./follow/follow";
import * as comments from "./comments/comments";
import * as activity from "./activity/activity";

async function requireOwnedHost(hostId: string, ownerId: string): Promise<void> {
    const host = await prisma.host.findFirst({ where: { id: hostId, ownerId }, select: { id: true } });
    if (!host) throw new Error("Server not found");
}

/** What has happened to this server. */
export async function serverHistory(hostId: string, ownerId: string): Promise<activity.ActivityLine[]> {
    await requireOwnedHost(hostId, ownerId);
    return activity.history("host", hostId, 60);
}

/** Write one line of it. Called by whatever changes the server. */
export async function recordServerEvent(
    hostId: string,
    actorId: string | null,
    action: string,
    values?: { from?: string | null; to?: string | null }
): Promise<void> {
    await activity.record({
        subjectType: "host",
        subjectId: hostId,
        userId: actorId,
        action,
        fromValue: values?.from ?? null,
        toValue: values?.to ?? null
    });
}

export async function serverNotes(hostId: string, ownerId: string): Promise<comments.CommentView[]> {
    await requireOwnedHost(hostId, ownerId);
    return comments.thread("host", hostId);
}

export async function postServerNote(hostId: string, ownerId: string, body: string): Promise<void> {
    await requireOwnedHost(hostId, ownerId);
    await comments.post(ownerId, { subjectType: "host", subjectId: hostId, body });
}

export async function deleteServerNote(hostId: string, ownerId: string, commentId: string): Promise<void> {
    await requireOwnedHost(hostId, ownerId);
    // Only the server's owner gets past the check above, and the owner moderates
    // their own server's notes.
    await comments.remove(ownerId, commentId, true);
}

export async function isFollowingServer(hostId: string, userId: string): Promise<boolean> {
    await requireOwnedHost(hostId, userId);
    return follow.isFollowing("host", hostId, userId);
}

export async function setFollowingServer(hostId: string, userId: string, following: boolean): Promise<void> {
    await requireOwnedHost(hostId, userId);
    if (following) await follow.follow("host", hostId, userId);
    else await follow.unfollow("host", hostId, userId);
}

/**
 * Everything the shared tables hold about a server, dropped when the server is.
 * None of it cascades - that is the price of one table per concern rather than
 * one per app - so removing a server calls this.
 */
export async function forgetServer(hostId: string): Promise<void> {
    await activity.forget("host", hostId);
    await comments.forget("host", hostId);
    await follow.forget("host", hostId);
}
