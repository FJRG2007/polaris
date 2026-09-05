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
    /** Who wrote it. No picture: a face is resolved from the id, through the one
     *  route that decides between an upload, a linked account's picture and a
     *  Gravatar. */
    readonly author: { readonly id: string; readonly name: string } | null;
    /**
     * What was sent with it.
     *
     * Empty for every comment on every subject but a task: this is the one place
     * files are sent in a thread, and the shape is here rather than in a second
     * view so the bubble that draws a comment does not need two of them.
     */
    readonly files: readonly CommentFile[];
}

/** A file sent with a comment, as the thread draws it. */
export interface CommentFile {
    readonly id: string;
    readonly name: string;
    readonly mime: string;
    readonly size: number;
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
            // Not the picture an OAuth provider handed better-auth: a face is
            // resolved from the account id, through the one route that puts an
            // uploaded photo first. Read here, it outranked the photo somebody
            // chose and went on being drawn after they took it down.
            user: { select: { id: true, name: true } }
        }
    });
    // What was sent with them, in one read rather than one per comment. Only a
    // task has files in its thread, so nothing else pays for the query.
    //
    // Matched on the task as well as on the comment. A row carries both, and the
    // pair is the only thing that says a file belongs in this conversation: on
    // the comment alone, a row written against a comment of another task - by an
    // older Polaris, or by somebody who tried - would be drawn here, in a thread
    // its uploader may never have been able to read.
    const files =
        subjectType === "task" && rows.length > 0
            ? await prisma.taskAttachment.findMany({
                  where: { taskId: subjectId, commentId: { in: rows.map((row) => row.id) } },
                  orderBy: { createdAt: "asc" },
                  select: { id: true, name: true, mime: true, size: true, commentId: true }
              })
            : [];
    const byComment = new Map<string, CommentFile[]>();
    for (const file of files) {
        if (!file.commentId) continue;
        const bucket = byComment.get(file.commentId) ?? [];
        bucket.push({ id: file.id, name: file.name, mime: file.mime, size: file.size });
        byComment.set(file.commentId, bucket);
    }

    return rows.map((row) => ({
        id: row.id,
        body: row.body,
        parentId: row.parentId,
        assignedToId: row.assignedToId,
        resolvedAt: row.resolvedAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
        author: row.user,
        files: byComment.get(row.id) ?? []
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
