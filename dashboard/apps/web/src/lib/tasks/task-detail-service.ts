/**
 * The things that hang off a task: comments, checklists, dependencies, watchers
 * and custom-field values.
 *
 * Split from task-service because they are a different job. That module owns the
 * task row and everything that changes its shape (status, dates, order, rules);
 * this one owns the satellites, which are simple writes that mostly need to tell
 * the right people afterwards.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { notify } from "@/lib/notifications/dispatch";
import { runAutomations } from "./automation-service";
import { notifyMentions } from "@/lib/rich-text/mention-notify";

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

/** Everyone who should hear about activity on a task: its assignees and its
 *  watchers, minus whoever caused it. */
async function audience(taskId: string, exceptUserId: string | null): Promise<string[]> {
    const [assignees, watchers] = await Promise.all([
        prisma.taskAssignee.findMany({ where: { taskId }, select: { userId: true } }),
        prisma.taskWatcher.findMany({ where: { taskId }, select: { userId: true } })
    ]);
    const people = new Set([...assignees, ...watchers].map((entry) => entry.userId));
    if (exceptUserId) people.delete(exceptUserId);
    return [...people];
}

/**
 * Post a comment. Commenting also starts watching the task, which is the
 * behaviour people expect: having said something, you want to hear the reply.
 */
export async function addComment(actorId: string, input: core.CommentInput): Promise<string> {
    const comment = await prisma.taskComment.create({
        data: {
            taskId: input.taskId,
            parentId: input.parentId,
            userId: actorId,
            body: input.body,
            assignedToId: input.assignedToId
        },
        select: { id: true }
    });
    await prisma.taskWatcher
        .create({ data: { taskId: input.taskId, userId: actorId } })
        .catch(() => undefined);

    const task = await prisma.task.findUnique({
        where: { id: input.taskId },
        select: { name: true, spaceId: true }
    });
    const recipients = new Set(await audience(input.taskId, actorId));
    // The person a comment was handed to hears about it whether or not they
    // were already following the task.
    if (input.assignedToId && input.assignedToId !== actorId) recipients.add(input.assignedToId);

    for (const userId of recipients) {
        await notify({
            userId,
            event: "tasks.comment",
            title: task?.name ?? "A task",
            body: input.body.slice(0, 200),
            href: `/tasks/t/${input.taskId}`
        });
    }
    // Being named in a comment reaches somebody who follows none of this. The
    // people above have already heard about it, so they are not told twice.
    await notifyMentions({
        body: input.body,
        actorId,
        title: task?.name ?? "A task",
        href: `/tasks/t/${input.taskId}`,
        spaceId: task?.spaceId ?? null,
        except: [...recipients]
    });
    await runAutomations({ trigger: "task.commentAdded", taskId: input.taskId, actorId });
    return comment.id;
}

/** Only the author may rewrite what they said. */
export async function editComment(actorId: string, commentId: string, body: string): Promise<void> {
    const updated = await prisma.taskComment.updateMany({
        where: { id: commentId, userId: actorId },
        data: { body }
    });
    if (updated.count === 0) throw new Error("You can only edit your own comments");
}

export async function deleteComment(actorId: string, commentId: string, canModerate: boolean): Promise<void> {
    const deleted = await prisma.taskComment.deleteMany({
        where: canModerate ? { id: commentId } : { id: commentId, userId: actorId }
    });
    if (deleted.count === 0) throw new Error("You can only delete your own comments");
}

/** Mark a comment dealt with, or reopen it. */
export async function setCommentResolved(actorId: string, commentId: string, resolved: boolean): Promise<void> {
    await prisma.taskComment.update({
        where: { id: commentId },
        data: { resolvedAt: resolved ? new Date() : null, resolvedById: resolved ? actorId : null }
    });
}

// ---------------------------------------------------------------------------
// Checklists
// ---------------------------------------------------------------------------

export async function createChecklist(taskId: string, name: string): Promise<string> {
    const last = await prisma.taskChecklist.findFirst({
        where: { taskId },
        orderBy: { order: "desc" },
        select: { order: true }
    });
    const checklist = await prisma.taskChecklist.create({
        data: { taskId, name, order: (last?.order ?? 0) + core.ORDER_STEP },
        select: { id: true }
    });
    return checklist.id;
}

export async function renameChecklist(checklistId: string, name: string): Promise<void> {
    await prisma.taskChecklist.update({ where: { id: checklistId }, data: { name } });
}

/**
 * The order key for a row dropped between two others.
 *
 * The drop is reported as the two neighbours rather than an index, the same way
 * a task drag is, so two people rearranging the same checklist at once cannot
 * renumber each other. When the gap between the neighbours has run out of room
 * the whole container is re-spaced first and the neighbours are read again.
 */
async function orderForDrop(
    read: (id: string) => Promise<number | null>,
    rebalance: () => Promise<void>,
    move: { beforeId: string | null; afterId: string | null }
): Promise<number | null> {
    const before = move.beforeId ? await read(move.beforeId) : null;
    const after = move.afterId ? await read(move.afterId) : null;
    // A neighbour that has since been deleted means the drop was aimed at a row
    // that is no longer there; refusing beats guessing a position.
    if ((move.beforeId && before === null) || (move.afterId && after === null)) return null;

    if (!core.needsRebalance(before, after)) return core.orderBetween(before, after);

    await rebalance();
    const spacedBefore = move.beforeId ? await read(move.beforeId) : null;
    const spacedAfter = move.afterId ? await read(move.afterId) : null;
    return core.orderBetween(spacedBefore, spacedAfter);
}

/** Reorder the checklists on one task after a drag. */
export async function moveChecklist(
    taskId: string,
    checklistId: string,
    move: { beforeId: string | null; afterId: string | null }
): Promise<void> {
    const order = await orderForDrop(
        async (id) => (await prisma.taskChecklist.findUnique({ where: { id }, select: { order: true } }))?.order ?? null,
        async () => {
            const siblings = await prisma.taskChecklist.findMany({
                where: { taskId },
                orderBy: [{ order: "asc" }, { createdAt: "asc" }],
                select: { id: true }
            });
            const orders = core.rebalanceOrders(siblings.length);
            await prisma.$transaction(
                siblings.map((row, index) =>
                    prisma.taskChecklist.update({ where: { id: row.id }, data: { order: orders[index] } })
                )
            );
        },
        move
    );
    if (order === null) throw new Error("That spot has moved. Try again");
    await prisma.taskChecklist.update({ where: { id: checklistId }, data: { order } });
}

/**
 * Reorder a step, or move it to another checklist on the same task. Dragging a
 * step from "Design" to "Build" is the same gesture as moving it up two rows, so
 * it is the same call rather than a cut and a paste.
 */
export async function moveChecklistItem(
    taskId: string,
    itemId: string,
    move: { checklistId: string; beforeId: string | null; afterId: string | null }
): Promise<void> {
    const [item, destination] = await Promise.all([
        prisma.taskChecklistItem.findUnique({
            where: { id: itemId },
            select: { checklist: { select: { taskId: true } } }
        }),
        prisma.taskChecklist.findUnique({ where: { id: move.checklistId }, select: { taskId: true } })
    ]);
    // Both ends have to be on the task the caller was authorized for, or a drag
    // would be a way to write into a checklist on somebody else's task.
    if (!item || item.checklist.taskId !== taskId) throw new Error("That step no longer exists");
    if (!destination || destination.taskId !== taskId) throw new Error("That checklist no longer exists");

    const order = await orderForDrop(
        async (id) =>
            (await prisma.taskChecklistItem.findUnique({ where: { id }, select: { order: true } }))?.order ?? null,
        async () => {
            const siblings = await prisma.taskChecklistItem.findMany({
                where: { checklistId: move.checklistId },
                orderBy: [{ order: "asc" }, { createdAt: "asc" }],
                select: { id: true }
            });
            const orders = core.rebalanceOrders(siblings.length);
            await prisma.$transaction(
                siblings.map((row, index) =>
                    prisma.taskChecklistItem.update({ where: { id: row.id }, data: { order: orders[index] } })
                )
            );
        },
        move
    );
    if (order === null) throw new Error("That spot has moved. Try again");
    await prisma.taskChecklistItem.update({
        where: { id: itemId },
        data: { checklistId: move.checklistId, order }
    });
}

export async function deleteChecklist(checklistId: string): Promise<void> {
    await prisma.taskChecklist.delete({ where: { id: checklistId } });
}

export async function addChecklistItem(checklistId: string, name: string): Promise<string> {
    const last = await prisma.taskChecklistItem.findFirst({
        where: { checklistId },
        orderBy: { order: "desc" },
        select: { order: true }
    });
    const item = await prisma.taskChecklistItem.create({
        data: { checklistId, name, order: (last?.order ?? 0) + core.ORDER_STEP },
        select: { id: true }
    });
    return item.id;
}

export async function setChecklistItemDone(itemId: string, done: boolean): Promise<void> {
    await prisma.taskChecklistItem.update({
        where: { id: itemId },
        data: { done, doneAt: done ? new Date() : null }
    });
}

export async function updateChecklistItem(
    itemId: string,
    input: { name?: string; assigneeId?: string | null }
): Promise<void> {
    await prisma.taskChecklistItem.update({
        where: { id: itemId },
        data: {
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.assigneeId !== undefined ? { assigneeId: input.assigneeId } : {})
        }
    });
}

export async function deleteChecklistItem(itemId: string): Promise<void> {
    await prisma.taskChecklistItem.delete({ where: { id: itemId } });
}

/**
 * Turn a checklist item into a real task in the same list. A step that grew
 * dates and an owner has stopped being a step, and re-typing it by hand is how
 * the two copies drift apart.
 */
export async function promoteChecklistItem(
    itemId: string,
    create: (name: string) => Promise<{ id: string }>
): Promise<string | null> {
    const item = await prisma.taskChecklistItem.findUnique({
        where: { id: itemId },
        select: { name: true, checklist: { select: { taskId: true } } }
    });
    if (!item) return null;
    const created = await create(item.name);
    await prisma.taskChecklistItem.delete({ where: { id: itemId } });
    return created.id;
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

/**
 * Link two tasks. A "blocks" edge that would close a loop is refused: a cycle
 * makes a gantt chart unsolvable and a "what is blocked" query never terminate,
 * and the moment to catch it is the moment somebody draws it.
 */
export async function addDependency(spaceId: string, input: core.DependencyInput): Promise<void> {
    if (input.taskId === input.relatedTaskId) throw new Error("A task cannot depend on itself");

    const related = await prisma.task.findFirst({
        where: { id: input.relatedTaskId, spaceId },
        select: { id: true }
    });
    if (!related) throw new Error("That task is not in this space");

    const blockerId = input.reverse ? input.relatedTaskId : input.taskId;
    const blockedId = input.reverse ? input.taskId : input.relatedTaskId;

    if (input.type === "blocks") {
        const edges = await prisma.taskDependency.findMany({
            where: { type: "blocks", blocker: { spaceId } },
            select: { blockerId: true, blockedId: true }
        });
        if (core.wouldCycle(edges, blockerId, blockedId)) {
            throw new Error("That would make the two tasks wait on each other");
        }
    }

    await prisma.taskDependency
        .create({ data: { blockerId, blockedId, type: input.type } })
        .catch(() => undefined);
}

export async function removeDependency(dependencyId: string): Promise<void> {
    await prisma.taskDependency.deleteMany({ where: { id: dependencyId } });
}

// ---------------------------------------------------------------------------
// Watchers
// ---------------------------------------------------------------------------

export async function setWatching(taskId: string, userId: string, watching: boolean): Promise<void> {
    if (watching) {
        await prisma.taskWatcher.create({ data: { taskId, userId } }).catch(() => undefined);
        return;
    }
    await prisma.taskWatcher.deleteMany({ where: { taskId, userId } });
}

// ---------------------------------------------------------------------------
// Custom field values
// ---------------------------------------------------------------------------

/**
 * Write one custom-field answer. An empty value clears the row rather than
 * storing "", so "is not set" keeps meaning what it says.
 */
export async function setCustomValue(
    spaceId: string,
    taskId: string,
    fieldId: string,
    value: string
): Promise<void> {
    const field = await prisma.taskCustomField.findFirst({
        where: { id: fieldId, spaceId },
        select: { id: true }
    });
    if (!field) throw new Error("That field is not in this space");

    if (value === "") {
        await prisma.taskCustomFieldValue.deleteMany({ where: { taskId, fieldId } });
        return;
    }
    await prisma.taskCustomFieldValue.upsert({
        where: { taskId_fieldId: { taskId, fieldId } },
        update: { value },
        create: { taskId, fieldId, value }
    });
}

// ---------------------------------------------------------------------------
// Reminders
// ---------------------------------------------------------------------------

export async function addReminder(userId: string, taskId: string, remindAt: string, note: string): Promise<void> {
    await prisma.taskReminder.create({ data: { userId, taskId, remindAt: new Date(remindAt), note } });
}

export async function deleteReminder(userId: string, reminderId: string): Promise<void> {
    await prisma.taskReminder.deleteMany({ where: { id: reminderId, userId } });
}

/**
 * How late a reminder may be and still be worth sending.
 *
 * Past this it has been overtaken by whatever it was about, and the only thing
 * telling somebody now achieves is a pile of notifications the first time an
 * instance comes back from a long stop. Retired quietly instead.
 */
const REMINDER_STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Send every reminder that has come due and mark it sent. Run from the schedule
 * rather than from a timer in the request path, so a reminder still fires on an
 * instance nobody has open.
 *
 * One at a time, each marked as it goes and each failure kept to itself. It used
 * to send the whole batch and then mark the batch, which meant a single refused
 * notification left everything before it unmarked - so all of them went again on
 * the next pass, and the one after that, forever. That was survivable while
 * something external had to ask for it and is a notification a minute now.
 */
export async function dispatchDueReminders(now = new Date()): Promise<number> {
    const due = await prisma.taskReminder.findMany({
        where: { sentAt: null, remindAt: { lte: now } },
        take: 200,
        select: {
            id: true,
            userId: true,
            note: true,
            taskId: true,
            remindAt: true,
            task: { select: { name: true } }
        }
    });

    let sent = 0;
    for (const reminder of due) {
        const late = now.getTime() - reminder.remindAt.getTime();
        if (late <= REMINDER_STALE_AFTER_MS) {
            try {
                await notify({
                    userId: reminder.userId,
                    event: "tasks.due",
                    title: reminder.task.name,
                    body: reminder.note || "The reminder you set on this task.",
                    href: `/tasks/t/${reminder.taskId}`
                });
                sent += 1;
            } catch (error) {
                console.error("polaris: a task reminder could not be delivered:", error);
            }
        }
        // Marked either way. A reminder nobody could be told about is still a
        // reminder that has had its moment, and leaving it unmarked only means
        // trying again every minute until the end of time.
        await prisma.taskReminder
            .update({ where: { id: reminder.id }, data: { sentAt: now } })
            .catch((error: unknown) =>
                console.error("polaris: a sent reminder could not be marked, so it will be retried:", error)
            );
    }
    return sent;
}
