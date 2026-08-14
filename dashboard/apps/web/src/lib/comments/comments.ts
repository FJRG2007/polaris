/**
 * A discussion about something, for any something.
 *
 * The same story as `lib/activity`: a task was the only thing in Polaris with a
 * comment box, because the table had a foreign key to one. A server that keeps
 * failing, a deploy somebody rolled back, a vault item two people share - all
 * are things there is something to say about, and none of them had anywhere to
 * say it.
 *
 * What is here is the thread and nothing else. Who hears about a comment is not:
 * a task tells its assignees, its watchers and anybody mentioned, and runs its
 * rules; a service will tell whoever is following it. That belongs to the app
 * that owns the subject, which composes this module rather than being served by
 * it.
 *
 * As with activity, nothing cascades - `forget` is called by whatever deletes
 * the subject.
 */

import { prisma, type Prisma } from "@polaris/db";
import type { ActivitySubject } from "@/lib/activity/activity";

/** The same vocabulary of subjects the history uses. A thing worth discussing is
 *  a thing worth a history, so there is one list rather than two that drift. */
export type CommentSubject = ActivitySubject;

export interface CommentView {
    readonly id: string;
    readonly body: string;
    readonly parentId: string | null;
    readonly assignedToId: string | null;
    readonly resolvedAt: string | null;
    readonly createdAt: string;
    readonly author: { readonly id: string; readonly name: string; readonly image: string | null } | null;
}

export interface CommentInput {
    readonly subjectType: CommentSubject;
    readonly subjectId: string;
    readonly body: string;
    /** One level of nesting only; a reply to a reply is how a thread becomes a
     *  forum. Enforced by the callers that offer replies at all. */
    readonly parentId?: string | null;
    /** Hand the comment to somebody as an action item. */
    readonly assignedToId?: string | null;
}

/** Post one. Returns its id so the caller can notify about it. */
export async function post(
    actorId: string | null,
    input: CommentInput,
    client: Prisma.TransactionClient = prisma
): Promise<string> {
    const comment = await client.comment.create({
        data: {
            subjectType: input.subjectType,
            subjectId: input.subjectId,
            parentId: input.parentId ?? null,
            userId: actorId,
            body: input.body,
            assignedToId: input.assignedToId ?? null
        },
        select: { id: true }
    });
    return comment.id;
}

/** The thread, oldest first - the order it was said in. */
export async function thread(
    subjectType: CommentSubject,
    subjectId: string,
    limit = 500
): Promise<CommentView[]> {
    const rows = await prisma.comment.findMany({
        where: { subjectType, subjectId },
        orderBy: { createdAt: "asc" },
        take: limit,
        select: {
            id: true,
            body: true,
            parentId: true,
            assignedToId: true,
            resolvedAt: true,
            createdAt: true,
            user: { select: { id: true, name: true, image: true } }
        }
    });
    return rows.map((row) => ({
        id: row.id,
        body: row.body,
        parentId: row.parentId,
        assignedToId: row.assignedToId,
        resolvedAt: row.resolvedAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
        author: row.user
    }));
}

/** Only the author may rewrite what they said. */
export async function edit(actorId: string, commentId: string, body: string): Promise<void> {
    const updated = await prisma.comment.updateMany({ where: { id: commentId, userId: actorId }, data: { body } });
    if (updated.count === 0) throw new Error("You can only edit your own comments");
}

/** The author, or somebody the owning app decided may moderate. */
export async function remove(actorId: string, commentId: string, canModerate: boolean): Promise<void> {
    const deleted = await prisma.comment.deleteMany({
        where: canModerate ? { id: commentId } : { id: commentId, userId: actorId }
    });
    if (deleted.count === 0) throw new Error("You can only delete your own comments");
}

/** Mark one dealt with, or reopen it. */
export async function setResolved(actorId: string, commentId: string, resolved: boolean): Promise<void> {
    await prisma.comment.update({
        where: { id: commentId },
        data: { resolvedAt: resolved ? new Date() : null, resolvedById: resolved ? actorId : null }
    });
}

/** How many, for a screen that shows a count beside a tab. */
export async function count(subjectType: CommentSubject, subjectId: string): Promise<number> {
    return prisma.comment.count({ where: { subjectType, subjectId } });
}

/** Drop the whole discussion, for whatever deletes the subject. */
export async function forget(
    subjectType: CommentSubject,
    subjectId: string | readonly string[],
    client: Prisma.TransactionClient = prisma
): Promise<void> {
    const ids = typeof subjectId === "string" ? [subjectId] : [...subjectId];
    if (ids.length === 0) return;
    await client.comment.deleteMany({ where: { subjectType, subjectId: { in: ids } } });
}
