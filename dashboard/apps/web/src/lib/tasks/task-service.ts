/**
 * Reading and writing the tasks themselves.
 *
 * Three things are deliberately centralised here rather than left to call sites.
 * A task's reference number is allocated by incrementing the space counter
 * inside the same transaction that inserts the row, so two people typing at once
 * cannot be handed the same "ENG-42". Every field change writes an activity line
 * with the values already resolved to names, so the history panel never has to
 * look up a status that has since been deleted. And completing a recurring task
 * reschedules it instead of closing it, which is the behaviour people expect and
 * the one that is easy to get subtly wrong.
 *
 * Authorization happened in the action layer (see access.ts); everything here
 * takes ids that were already cleared.
 */

import * as core from "@polaris/core";
import { nextTaskNumber } from "./numbering";
import { prisma, type Prisma } from "@polaris/db";
import { notify } from "@/lib/notifications/dispatch";
import type { PersonRef, TagRef, TaskRow } from "./facts";
import { listCommits, type CommitLink } from "./commit-service";
import { listAttachments, type AttachmentView } from "./attachment-service";
import { hasAutomationsFor, runAutomations, runAutomationsFor } from "./automation-service";

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** Which tasks a screen is asking for. Every field narrows; an empty scope is
 *  refused by the caller rather than quietly returning the whole instance. */
export interface TaskScope {
    readonly listId?: string;
    /** Spaces the reader reaches in full. */
    readonly spaceIds?: string[];
    /** Lists the reader reaches through a folder grant, in spaces they do not
     *  hold in full. Read together with `spaceIds` as an either-or. */
    readonly listIds?: string[];
    readonly sprintId?: string;
    readonly assigneeId?: string;
    /** null asks for top-level tasks only, undefined for every level. */
    readonly parentId?: string | null;
}

export interface TaskQueryOptions {
    readonly includeArchived?: boolean;
    /** Leaves out work whose status counts as finished. For a screen that answers
     *  "what do I still have to do", where something ticked off has stopped being
     *  an answer. A task with no status at all is not finished. */
    readonly openOnly?: boolean;
    readonly limit?: number;
}

const ROW_SELECT = {
    id: true,
    number: true,
    name: true,
    description: true,
    spaceId: true,
    listId: true,
    parentId: true,
    statusId: true,
    priority: true,
    startDate: true,
    dueDate: true,
    timed: true,
    timeEstimate: true,
    points: true,
    milestone: true,
    archived: true,
    order: true,
    sprintId: true,
    recurrence: true,
    blockedUntil: true,
    blockedNote: true,
    completedAt: true,
    createdById: true,
    createdAt: true,
    updatedAt: true,
    space: { select: { prefix: true, name: true } },
    // The folder comes with the list: a screen that spans spaces has to say
    // where each task lives, and that is one join rather than a query per row.
    list: { select: { name: true, folder: { select: { name: true } } } },
    status: { select: { id: true, name: true, color: true, type: true } },
    assignees: { select: { user: { select: { id: true, name: true, image: true } } } },
    tags: { select: { tag: { select: { id: true, name: true, color: true } } } },
    fieldValues: { select: { fieldId: true, value: true } },
    _count: { select: { subtasks: true, comments: true } }
} as const;

type TaskRecord = Prisma.TaskGetPayload<{ select: typeof ROW_SELECT }>;

/**
 * Tracked time and the dependency half of blocked-ness, for a set of tasks, in
 * two queries rather than two per row. Neither belongs on the task table: time
 * is a sum over entries, and this kind of block is a question about other tasks.
 *
 * The other ways a task gets held up need no query at all: the stage it sits in
 * arrives with the row, and the date it waits for and the reason somebody wrote
 * are columns on the task itself. `toRow` folds all four into the one answer a
 * card draws.
 */
async function decorate(ids: string[]): Promise<{ tracked: Map<string, number>; blocked: Set<string> }> {
    if (ids.length === 0) return { tracked: new Map(), blocked: new Set() };
    const [entries, dependencies] = await Promise.all([
        prisma.taskTimeEntry.groupBy({ by: ["taskId"], where: { taskId: { in: ids } }, _sum: { seconds: true } }),
        prisma.taskDependency.findMany({
            where: { blockedId: { in: ids }, type: "blocks" },
            select: { blockedId: true, blocker: { select: { status: { select: { type: true } } } } }
        })
    ]);
    const tracked = new Map(entries.map((entry) => [entry.taskId, entry._sum.seconds ?? 0]));
    const blocked = new Set(
        dependencies
            .filter((edge) => core.blockerHolds(edge.blocker.status?.type as core.TaskStatusType | undefined))
            .map((edge) => edge.blockedId)
    );
    return { tracked, blocked };
}

function toRow(
    record: NonNullable<TaskRecord>,
    tracked: Map<string, number>,
    blocked: Set<string>
): TaskRow {
    const status = record.status;
    return {
        id: record.id,
        reference: core.taskReference(record.space.prefix, record.number),
        name: record.name,
        description: record.description,
        spaceId: record.spaceId,
        spaceName: record.space.name,
        listId: record.listId,
        listName: record.list.name,
        folderName: record.list.folder?.name ?? null,
        parentId: record.parentId,
        statusId: record.statusId,
        statusName: status?.name ?? "No status",
        statusColor: status?.color ?? "#64748b",
        statusType: (status?.type as core.TaskStatusType) ?? "open",
        priority: record.priority as core.TaskPriority,
        assignees: record.assignees.map((entry): PersonRef => entry.user),
        tags: record.tags.map((entry): TagRef => entry.tag),
        createdById: record.createdById,
        startDate: record.startDate?.toISOString() ?? null,
        dueDate: record.dueDate?.toISOString() ?? null,
        timed: record.timed,
        timeEstimate: record.timeEstimate,
        points: record.points,
        milestone: record.milestone,
        archived: record.archived,
        order: record.order,
        sprintId: record.sprintId,
        completedAt: record.completedAt?.toISOString() ?? null,
        createdAt: record.createdAt.toISOString(),
        updatedAt: record.updatedAt.toISOString(),
        subtaskCount: record._count.subtasks,
        commentCount: record._count.comments,
        trackedSeconds: tracked.get(record.id) ?? 0,
        blockedUntil: record.blockedUntil?.toISOString() ?? null,
        blockedNote: record.blockedNote,
        blocked: core.taskIsBlocked(
            {
                statusType: (status?.type as core.TaskStatusType) ?? "open",
                dependsOnUnfinished: blocked.has(record.id),
                blockedUntil: record.blockedUntil,
                blockedNote: record.blockedNote
            },
            new Date()
        ),
        recurring: record.recurrence !== null,
        customValues: Object.fromEntries(record.fieldValues.map((value) => [value.fieldId, value.value]))
    };
}

/** The tasks a screen asked for, ordered by manual position. Views re-sort and
 *  re-group in the browser, so this never has to know about the saved sort. */
export async function listTasks(scope: TaskScope, options: TaskQueryOptions = {}): Promise<TaskRow[]> {
    const records = await prisma.task.findMany({
        where: {
            ...(scope.listId ? { listId: scope.listId } : {}),
            // Either-or rather than two narrowing clauses: a reader can hold one
            // space outright and a single folder in another, and both sets of
            // work belong on a cross-space screen.
            ...(scope.spaceIds || scope.listIds
                ? {
                      OR: [
                          ...(scope.spaceIds ? [{ spaceId: { in: scope.spaceIds } }] : []),
                          ...(scope.listIds ? [{ listId: { in: scope.listIds } }] : [])
                      ]
                  }
                : {}),
            ...(scope.sprintId ? { sprintId: scope.sprintId } : {}),
            ...(scope.assigneeId ? { assignees: { some: { userId: scope.assigneeId } } } : {}),
            ...(scope.parentId !== undefined ? { parentId: scope.parentId } : {}),
            ...(options.includeArchived ? {} : { archived: false }),
            // Under AND rather than beside the scope's own OR, which this would
            // otherwise replace and quietly widen the query to every space.
            ...(options.openOnly
                ? {
                      AND: [
                          {
                              OR: [
                                  { status: null },
                                  { status: { type: { in: [...core.UNFINISHED_STATUS_TYPES] } } }
                              ]
                          }
                      ]
                  }
                : {})
        },
        orderBy: [{ order: "asc" }, { createdAt: "asc" }],
        take: options.limit ?? 2000,
        select: ROW_SELECT
    });

    const { tracked, blocked } = await decorate(records.map((record) => record.id));
    return records.map((record) => toRow(record, tracked, blocked));
}

export interface ChecklistView {
    readonly id: string;
    readonly name: string;
    readonly items: {
        readonly id: string;
        readonly name: string;
        readonly done: boolean;
        readonly assigneeId: string | null;
    }[];
}

export interface CommentView {
    readonly id: string;
    readonly body: string;
    readonly parentId: string | null;
    readonly author: PersonRef | null;
    readonly assignedToId: string | null;
    readonly resolvedAt: string | null;
    readonly createdAt: string;
}

export interface DependencyView {
    readonly id: string;
    readonly type: core.DependencyType;
    /** Which side of the edge the other task is on, from this task's point of
     *  view: it blocks us, or we block it. */
    readonly direction: "blocking" | "waitingOn";
    readonly taskId: string;
    readonly reference: string;
    readonly name: string;
    readonly statusName: string;
    readonly statusColor: string;
    readonly finished: boolean;
}

export interface ActivityView {
    readonly id: string;
    readonly action: string;
    readonly fromValue: string | null;
    readonly toValue: string | null;
    readonly authorName: string | null;
    readonly createdAt: string;
}

export interface TimeEntryView {
    readonly id: string;
    readonly userId: string;
    readonly userName: string;
    readonly seconds: number;
    readonly note: string;
    readonly billable: boolean;
    readonly startedAt: string;
    readonly running: boolean;
}

/** Everything the task panel shows, beyond what a row already carries. */
export interface TaskDetail {
    readonly task: TaskRow;
    readonly subtasks: TaskRow[];
    readonly watchers: PersonRef[];
    readonly checklists: ChecklistView[];
    readonly comments: CommentView[];
    readonly dependencies: DependencyView[];
    readonly activity: ActivityView[];
    readonly timeEntries: TimeEntryView[];
    readonly attachments: AttachmentView[];
    readonly commits: CommitLink[];
    readonly recurrence: core.Recurrence | null;
    readonly parent: { id: string; reference: string; name: string } | null;
}

export async function getTaskDetail(taskId: string): Promise<TaskDetail | null> {
    const record = await prisma.task.findUnique({ where: { id: taskId }, select: ROW_SELECT });
    if (!record) return null;

    const [
        decorated,
        subtasks,
        watchers,
        checklists,
        comments,
        blocking,
        blockedBy,
        activity,
        entries,
        parent,
        attachments,
        commits
    ] = await Promise.all([
            decorate([taskId]),
            listTasks({ parentId: taskId }, { includeArchived: true }),
            prisma.taskWatcher.findMany({
                where: { taskId },
                select: { user: { select: { id: true, name: true, image: true } } }
            }),
            prisma.taskChecklist.findMany({
                where: { taskId },
                orderBy: { order: "asc" },
                select: {
                    id: true,
                    name: true,
                    items: {
                        orderBy: { order: "asc" },
                        select: { id: true, name: true, done: true, assigneeId: true }
                    }
                }
            }),
            prisma.taskComment.findMany({
                where: { taskId },
                orderBy: { createdAt: "asc" },
                select: {
                    id: true,
                    body: true,
                    parentId: true,
                    assignedToId: true,
                    resolvedAt: true,
                    createdAt: true,
                    user: { select: { id: true, name: true, image: true } }
                }
            }),
            prisma.taskDependency.findMany({
                where: { blockerId: taskId },
                select: { id: true, type: true, blocked: { select: DEPENDENCY_SELECT } }
            }),
            prisma.taskDependency.findMany({
                where: { blockedId: taskId },
                select: { id: true, type: true, blocker: { select: DEPENDENCY_SELECT } }
            }),
            prisma.taskActivity.findMany({
                where: { taskId },
                orderBy: { createdAt: "desc" },
                take: 100,
                select: { id: true, action: true, fromValue: true, toValue: true, userId: true, createdAt: true }
            }),
            prisma.taskTimeEntry.findMany({
                where: { taskId },
                orderBy: { startedAt: "desc" },
                select: {
                    id: true,
                    userId: true,
                    seconds: true,
                    note: true,
                    billable: true,
                    startedAt: true,
                    endedAt: true,
                    user: { select: { name: true } }
                }
            }),
            record.parentId
                ? prisma.task.findUnique({
                      where: { id: record.parentId },
                      select: { id: true, name: true, number: true, space: { select: { prefix: true } } }
                  })
                : Promise.resolve(null),
            listAttachments(taskId),
            listCommits(taskId)
        ]);

    const authorIds = [...new Set(activity.map((line) => line.userId).filter((id): id is string => id !== null))];
    const authors = authorIds.length
        ? await prisma.user.findMany({ where: { id: { in: authorIds } }, select: { id: true, name: true } })
        : [];
    const authorName = new Map(authors.map((author) => [author.id, author.name]));

    return {
        task: toRow(record, decorated.tracked, decorated.blocked),
        subtasks,
        watchers: watchers.map((watcher) => watcher.user),
        checklists,
        comments: comments.map((comment) => ({
            id: comment.id,
            body: comment.body,
            parentId: comment.parentId,
            author: comment.user,
            assignedToId: comment.assignedToId,
            resolvedAt: comment.resolvedAt?.toISOString() ?? null,
            createdAt: comment.createdAt.toISOString()
        })),
        dependencies: [
            ...blocking.map((edge) => toDependency(edge.id, edge.type, "blocking", edge.blocked)),
            ...blockedBy.map((edge) => toDependency(edge.id, edge.type, "waitingOn", edge.blocker))
        ],
        activity: activity.map((line) => ({
            id: line.id,
            action: line.action,
            fromValue: line.fromValue,
            toValue: line.toValue,
            authorName: line.userId ? (authorName.get(line.userId) ?? null) : null,
            createdAt: line.createdAt.toISOString()
        })),
        timeEntries: entries.map((entry) => ({
            id: entry.id,
            userId: entry.userId,
            userName: entry.user.name,
            seconds: entry.seconds,
            note: entry.note,
            billable: entry.billable,
            startedAt: entry.startedAt.toISOString(),
            running: entry.endedAt === null
        })),
        attachments,
        commits,
        recurrence: core.parseRecurrence(record.recurrence),
        parent: parent
            ? { id: parent.id, reference: core.taskReference(parent.space.prefix, parent.number), name: parent.name }
            : null
    };
}

const DEPENDENCY_SELECT = {
    id: true,
    name: true,
    number: true,
    space: { select: { prefix: true } },
    status: { select: { name: true, color: true, type: true } }
} as const;

function toDependency(
    id: string,
    type: string,
    direction: "blocking" | "waitingOn",
    other: {
        id: string;
        name: string;
        number: number;
        space: { prefix: string };
        status: { name: string; color: string; type: string } | null;
    }
): DependencyView {
    return {
        id,
        type: type as core.DependencyType,
        direction,
        taskId: other.id,
        reference: core.taskReference(other.space.prefix, other.number),
        name: other.name,
        statusName: other.status?.name ?? "No status",
        statusColor: other.status?.color ?? "#64748b",
        finished: other.status ? core.isFinishedStatus(other.status.type as core.TaskStatusType) : false
    };
}

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

/** One line of history. Values arrive already human-readable so the panel is a
 *  render rather than a second round of lookups. */
async function logActivity(
    taskId: string,
    userId: string | null,
    action: string,
    fromValue?: string | null,
    toValue?: string | null
): Promise<void> {
    await prisma.taskActivity.create({
        data: { taskId, userId, action, fromValue: fromValue ?? null, toValue: toValue ?? null }
    });
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/** The status a new task starts on: the first one the space defined. */
async function defaultStatusId(spaceId: string): Promise<string | null> {
    const status = await prisma.taskStatus.findFirst({
        where: { spaceId },
        orderBy: [{ order: "asc" }, { createdAt: "asc" }],
        select: { id: true }
    });
    return status?.id ?? null;
}

/**
 * The status row a task in this space may actually hold.
 *
 * A status belongs to one space, but a board that spans several shows one column
 * per status *name* - three spaces that all call it "Done" share the one Done
 * column (see `statusColumns`). So what arrives from such a screen is whichever
 * space's row happened to key the column, and moving a task there means "put it
 * on what this task's own space calls that". Anything else would either refuse
 * an ordinary drag or file the task under another space's status.
 *
 * Throws when the space has nothing by that name: silently leaving the status
 * unchanged after a drop looks exactly like the board rejecting the drag.
 */
async function statusInSpace(spaceId: string, statusId: string): Promise<{ id: string; type: string }> {
    const given = await prisma.taskStatus.findUnique({
        where: { id: statusId },
        select: { id: true, name: true, type: true, spaceId: true }
    });
    if (!given) throw new Error("That status no longer exists");
    if (given.spaceId === spaceId) return { id: given.id, type: given.type };

    // Matched in memory rather than in the query: a space holds a handful of
    // statuses, and Prisma's case-insensitive filter is Postgres-only while this
    // schema has to keep working on SQLite.
    const owned = await prisma.taskStatus.findMany({ where: { spaceId }, select: { id: true, name: true, type: true } });
    const needle = given.name.trim().toLowerCase();
    const sameName = owned.find((status) => status.name.trim().toLowerCase() === needle);
    if (!sameName) throw new Error(`This task's space has no status called "${given.name}"`);
    return { id: sameName.id, type: sameName.type };
}

async function nextOrderInList(listId: string): Promise<number> {
    const last = await prisma.task.findFirst({
        where: { listId },
        orderBy: { order: "desc" },
        select: { order: true }
    });
    return (last?.order ?? 0) + core.ORDER_STEP;
}

/**
 * Create a task. The reference number and the row are written in one
 * transaction, so a race hands out two numbers rather than one number twice.
 */
export async function createTask(
    actorId: string | null,
    spaceId: string,
    input: core.TaskCreateInput
): Promise<{ id: string; reference: string }> {
    const statusId = input.statusId
        ? (await statusInSpace(spaceId, input.statusId)).id
        : await defaultStatusId(spaceId);
    const order = await nextOrderInList(input.listId);

    const created = await prisma.$transaction(async (tx) => {
        const { number, prefix } = await nextTaskNumber(tx, spaceId);
        const task = await tx.task.create({
            data: {
                spaceId,
                listId: input.listId,
                parentId: input.parentId,
                number,
                name: input.name,
                description: input.description,
                statusId,
                priority: input.priority,
                startDate: input.startDate ? new Date(input.startDate) : null,
                dueDate: input.dueDate ? new Date(input.dueDate) : null,
                timed: input.timed,
                timeEstimate: input.timeEstimate,
                points: input.points,
                sprintId: input.sprintId,
                milestone: input.milestone,
                recurrence: input.recurrence ? JSON.stringify(input.recurrence) : null,
                order,
                createdById: actorId,
                assignees: { create: input.assigneeIds.map((userId) => ({ userId })) },
                tags: { create: input.tagIds.map((tagId) => ({ tagId })) }
            },
            select: { id: true }
        });
        return { id: task.id, reference: core.taskReference(prefix, number) };
    });

    await logActivity(created.id, actorId, "created");
    await announceAssignment(created.id, input.name, input.assigneeIds, actorId);
    await runAutomations({ trigger: "task.created", taskId: created.id, actorId });
    return created;
}

/** Tell the people a task was just handed to, minus whoever did the handing. */
async function announceAssignment(
    taskId: string,
    taskName: string,
    assigneeIds: readonly string[],
    actorId: string | null
): Promise<void> {
    for (const userId of assigneeIds) {
        if (userId === actorId) continue;
        await notify({
            userId,
            event: "tasks.assigned",
            title: taskName,
            body: "You were assigned this task.",
            href: `/tasks/t/${taskId}`
        });
    }
}

/** The names a history line needs, resolved once per update. */
async function statusName(statusId: string | null | undefined): Promise<string | null> {
    if (!statusId) return null;
    const status = await prisma.taskStatus.findUnique({ where: { id: statusId }, select: { name: true } });
    return status?.name ?? null;
}

/**
 * Apply a partial change and record what it did.
 *
 * `completedAt` follows the status kind rather than being set by the caller: it
 * is stamped the first time a task reaches done/closed and cleared when it comes
 * back, which is what a burndown and a "finished this week" report count on.
 */
export async function updateTask(actorId: string, input: core.TaskUpdateInput): Promise<void> {
    const before = await prisma.task.findUnique({
        where: { id: input.taskId },
        select: {
            spaceId: true,
            listId: true,
            name: true,
            statusId: true,
            priority: true,
            dueDate: true,
            completedAt: true,
            recurrence: true,
            blockedUntil: true,
            blockedNote: true,
            assignees: { select: { userId: true } },
            tags: { select: { tagId: true } }
        }
    });
    if (!before) throw new Error("That task no longer exists");

    const data: Record<string, unknown> = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.description !== undefined) data.description = input.description;
    if (input.priority !== undefined) data.priority = input.priority;
    if (input.startDate !== undefined) data.startDate = input.startDate ? new Date(input.startDate) : null;
    if (input.dueDate !== undefined) data.dueDate = input.dueDate ? new Date(input.dueDate) : null;
    if (input.timed !== undefined) data.timed = input.timed;
    if (input.timeEstimate !== undefined) data.timeEstimate = input.timeEstimate;
    if (input.points !== undefined) data.points = input.points;
    if (input.sprintId !== undefined) data.sprintId = input.sprintId;
    if (input.parentId !== undefined) data.parentId = input.parentId;
    if (input.milestone !== undefined) data.milestone = input.milestone;
    if (input.archived !== undefined) data.archived = input.archived;
    if (input.blockedUntil !== undefined) {
        data.blockedUntil = input.blockedUntil ? new Date(input.blockedUntil) : null;
    }
    if (input.blockedNote !== undefined) data.blockedNote = input.blockedNote;
    if (input.recurrence !== undefined) {
        data.recurrence = input.recurrence ? JSON.stringify(input.recurrence) : null;
    }

    let finished = false;
    // What the space itself calls the status asked for, which on a screen that
    // spans several spaces is not the row that was handed over.
    let movedTo: string | null = null;
    if (input.statusId !== undefined && input.statusId !== before.statusId) {
        const status = await statusInSpace(before.spaceId, input.statusId);
        finished = core.isFinishedStatus(status.type as core.TaskStatusType);
        movedTo = status.id;
        data.statusId = status.id;
        data.completedAt = finished ? (before.completedAt ?? new Date()) : null;
    }

    await prisma.task.update({ where: { id: input.taskId }, data });

    if (input.assigneeIds !== undefined) {
        await setAssignees(actorId, input.taskId, input.assigneeIds, before.assignees.map((entry) => entry.userId));
    }
    // Which tags this write is actually putting on the task, read from what it
    // held rather than from what was sent: the whole set arrives every time, so
    // saving a task with the tags it already had is not "a tag was added".
    let tagsAdded = false;
    if (input.tagIds !== undefined) {
        const held = new Set(before.tags.map((entry) => entry.tagId));
        tagsAdded = input.tagIds.some((tagId) => !held.has(tagId));
        await prisma.$transaction([
            prisma.taskTagLink.deleteMany({ where: { taskId: input.taskId } }),
            prisma.taskTagLink.createMany({ data: input.tagIds.map((tagId) => ({ taskId: input.taskId, tagId })) })
        ]);
    }

    // History, then rules: a rule that changes the task should read a task that
    // already reflects what the person did.
    if (movedTo !== null && movedTo !== before.statusId) {
        await logActivity(input.taskId, actorId, "status", await statusName(before.statusId), await statusName(movedTo));
    }
    if (input.priority !== undefined && input.priority !== before.priority) {
        await logActivity(
            input.taskId,
            actorId,
            "priority",
            core.TASK_PRIORITY_LABELS[before.priority as core.TaskPriority],
            core.TASK_PRIORITY_LABELS[input.priority]
        );
    }
    if (input.dueDate !== undefined) {
        await logActivity(
            input.taskId,
            actorId,
            "due",
            before.dueDate?.toISOString() ?? null,
            input.dueDate ?? null
        );
    }
    if (input.archived === true) await logActivity(input.taskId, actorId, "archived");
    // One line for the whole block, whichever half of it moved: "blocked until
    // Friday" and "blocked, waiting on legal" are one decision, and two lines in
    // the history read as two.
    if (input.blockedUntil !== undefined || input.blockedNote !== undefined) {
        // Read from what the task ends up holding, not from what was sent:
        // clearing the date while a written reason stands is still blocked, and
        // logging it as cleared would put the wrong sentence in the history.
        const until = input.blockedUntil !== undefined ? input.blockedUntil : (before.blockedUntil?.toISOString() ?? null);
        const note = input.blockedNote !== undefined ? input.blockedNote : before.blockedNote;
        const held = Boolean(until) || note !== "";
        const wasHeld = before.blockedUntil !== null || before.blockedNote !== "";
        if (held) await logActivity(input.taskId, actorId, "blocked", null, note || null);
        else if (wasHeld) await logActivity(input.taskId, actorId, "unblocked");
    }

    if (movedTo !== null && movedTo !== before.statusId) {
        await runAutomations({ trigger: "task.statusChanged", taskId: input.taskId, actorId });
        if (finished) {
            await runAutomations({ trigger: "task.completed", taskId: input.taskId, actorId });
            await rescheduleIfRecurring(input.taskId, actorId);
        }
    }
    if (input.priority !== undefined && input.priority !== before.priority) {
        await runAutomations({ trigger: "task.priorityChanged", taskId: input.taskId, actorId });
    }
    if (input.dueDate !== undefined && input.dueDate) {
        await runAutomations({ trigger: "task.dueDateSet", taskId: input.taskId, actorId });
    }
    if (tagsAdded) await runAutomations({ trigger: "task.tagAdded", taskId: input.taskId, actorId });
}

/**
 * A recurring task that is completed does not stay completed: its dates move to
 * the next occurrence and it returns to the first unstarted status, so the same
 * task carries its own history instead of spawning a copy every cycle.
 *
 * A rule with no next occurrence left (past its end date or its count) simply
 * stops recurring and the task stays done.
 */
async function rescheduleIfRecurring(taskId: string, actorId: string): Promise<void> {
    const task = await prisma.task.findUnique({
        where: { id: taskId },
        select: { recurrence: true, startDate: true, dueDate: true, spaceId: true }
    });
    const rule = core.parseRecurrence(task?.recurrence);
    if (!task || !rule) return;

    const anchor = rule.basis === "completion" ? new Date() : (task.dueDate ?? new Date());
    const occurrences = await prisma.taskActivity.count({ where: { taskId, action: "recurred" } });
    const nextDue = core.nextOccurrence(rule, anchor, occurrences);
    if (!nextDue) return;

    // Keep the gap between start and due, so a three-day job stays three days.
    const shift = task.startDate && task.dueDate ? task.dueDate.getTime() - task.startDate.getTime() : null;
    const openStatus = await prisma.taskStatus.findFirst({
        where: { spaceId: task.spaceId, type: "open" },
        orderBy: [{ order: "asc" }],
        select: { id: true }
    });

    await prisma.task.update({
        where: { id: taskId },
        data: {
            dueDate: nextDue,
            startDate: shift === null ? task.startDate : new Date(nextDue.getTime() - shift),
            completedAt: null,
            ...(openStatus ? { statusId: openStatus.id } : {})
        }
    });
    await logActivity(taskId, actorId, "recurred", null, nextDue.toISOString());
}

/** Replace the assignee set, telling whoever was added. */
export async function setAssignees(
    actorId: string,
    taskId: string,
    assigneeIds: readonly string[],
    previousIds?: readonly string[]
): Promise<void> {
    const before =
        previousIds ??
        (await prisma.taskAssignee.findMany({ where: { taskId }, select: { userId: true } })).map(
            (entry) => entry.userId
        );
    await prisma.$transaction([
        prisma.taskAssignee.deleteMany({ where: { taskId } }),
        prisma.taskAssignee.createMany({ data: assigneeIds.map((userId) => ({ taskId, userId })) })
    ]);

    const added = assigneeIds.filter((id) => !before.includes(id));
    if (added.length > 0) {
        const task = await prisma.task.findUnique({ where: { id: taskId }, select: { name: true } });
        await logActivity(taskId, actorId, "assignee", null, String(added.length));
        await announceAssignment(taskId, task?.name ?? "A task", added, actorId);
        await runAutomations({ trigger: "task.assigneeAdded", taskId, actorId });
    }
    if (assigneeIds.length < before.length) {
        await runAutomations({ trigger: "task.assigneeRemoved", taskId, actorId });
    }
}

/**
 * Put a task where it was dropped. The client sends the two neighbours rather
 * than a position, so the order key is computed from what is actually on screen
 * and two people dragging at once cannot swap each other's rows.
 */
export async function moveTask(actorId: string, input: core.TaskMoveInput): Promise<void> {
    const [before, after] = await Promise.all([
        input.beforeId
            ? prisma.task.findUnique({ where: { id: input.beforeId }, select: { order: true } })
            : Promise.resolve(null),
        input.afterId
            ? prisma.task.findUnique({ where: { id: input.afterId }, select: { order: true } })
            : Promise.resolve(null)
    ]);

    const current = await prisma.task.findUnique({
        where: { id: input.taskId },
        select: { listId: true, statusId: true, spaceId: true }
    });
    if (!current) throw new Error("That task no longer exists");

    const data: Record<string, unknown> = {
        order: core.orderBetween(before?.order ?? null, after?.order ?? null)
    };
    if (input.listId && input.listId !== current.listId) {
        const target = await prisma.taskList.findUnique({ where: { id: input.listId }, select: { spaceId: true } });
        if (!target || target.spaceId !== current.spaceId) {
            throw new Error("A task can only move between lists in the same space");
        }
        data.listId = input.listId;
    }
    if (input.statusId !== undefined && input.statusId !== current.statusId) {
        if (input.statusId === null) {
            // Dropped into the column of tasks that have no status yet.
            data.statusId = null;
            data.completedAt = null;
        } else {
            const status = await statusInSpace(current.spaceId, input.statusId);
            data.statusId = status.id;
            data.completedAt = core.isFinishedStatus(status.type as core.TaskStatusType) ? new Date() : null;
        }
    }

    await prisma.task.update({ where: { id: input.taskId }, data });

    // A drop into a gap that can no longer be split re-spaces just that list,
    // which is cheap and keeps the next drag honest.
    if (core.needsRebalance(before?.order ?? null, after?.order ?? null)) {
        await rebalanceList((data.listId as string) ?? current.listId);
    }

    if (data.listId) {
        await logActivity(input.taskId, actorId, "moved");
        await runAutomations({ trigger: "task.moved", taskId: input.taskId, actorId });
    }
    if (data.statusId) {
        await logActivity(input.taskId, actorId, "status", null, await statusName(input.statusId));
        await runAutomations({ trigger: "task.statusChanged", taskId: input.taskId, actorId });
        if (data.completedAt) {
            await runAutomations({ trigger: "task.completed", taskId: input.taskId, actorId });
            await rescheduleIfRecurring(input.taskId, actorId);
        }
    }
}

async function rebalanceList(listId: string): Promise<void> {
    const tasks = await prisma.task.findMany({
        where: { listId },
        orderBy: [{ order: "asc" }, { createdAt: "asc" }],
        select: { id: true }
    });
    const orders = core.rebalanceOrders(tasks.length);
    await prisma.$transaction(
        tasks.map((task, index) => prisma.task.update({ where: { id: task.id }, data: { order: orders[index] } }))
    );
}

/**
 * Write down the order a screen was showing.
 *
 * Sent when somebody drags a task on a view that was still in the order the
 * engine chose: the drag says where that one task belongs, and the rest of the
 * screen has to keep the places it was in or the board would rearrange itself
 * under the hand that just moved something. So the whole sequence is re-spaced
 * in one go, which is also what leaves room for the next drop between any two
 * of them.
 *
 * The ids arrive already narrowed to the tasks the caller may write, and in the
 * order they are to end up in.
 */
export async function arrangeTasks(taskIds: readonly string[]): Promise<number> {
    if (taskIds.length === 0) return 0;

    const current = await prisma.task.findMany({
        where: { id: { in: [...taskIds] } },
        select: { id: true, order: true }
    });
    const held = new Map(current.map((task) => [task.id, task.order]));
    const orders = core.rebalanceOrders(taskIds.length);
    // A drop moves one card past a few others, so most of a screen is usually
    // sitting where it is being told to sit already. Only the rows whose key
    // would actually change are written, and a task that has been deleted since
    // the screen loaded is nothing to write to at all.
    const changed = taskIds
        .map((id, index) => ({ id, order: orders[index] }))
        .filter((row) => held.has(row.id) && held.get(row.id) !== row.order);
    if (changed.length === 0) return 0;

    await prisma.$transaction(
        changed.map((row) => prisma.task.update({ where: { id: row.id }, data: { order: row.order } }))
    );
    return changed.length;
}

/**
 * Apply one change to a selection. Kept separate from updateTask so the fields a
 * bulk edit may touch stay an explicit, reviewable list.
 *
 * What follows the write is not separate, though. The same verbs reach this from
 * the row's own controls and from a right-click on a single task, and a menu that
 * quietly skipped the rules, the notification and the next occurrence of a
 * recurring job would make where you clicked decide what a status change means.
 * So the follow-ups are the ones a single write raises, per task, driven off what
 * each row actually changed rather than off what was asked for - a selection of
 * forty where two were already done raises two status changes, not forty.
 */
export async function bulkUpdate(
    actorId: string,
    allowed: readonly { id: string; spaceId: string }[],
    input: core.TaskBulkInput
): Promise<number> {
    // The selection arrives from the browser and is easy to forge, so what gets
    // here is the part of it the caller was cleared to change, resolved by the
    // access layer the way a single write is.
    const ids = allowed.map((task) => task.id);
    if (ids.length === 0) return 0;
    const spacesTouched = new Set(allowed.map((task) => task.spaceId));

    // What each row held before, in one query: the history lines say what moved,
    // and the rules run only where something did.
    const before = await prisma.task.findMany({
        where: { id: { in: ids } },
        select: {
            id: true,
            spaceId: true,
            name: true,
            listId: true,
            statusId: true,
            priority: true,
            dueDate: true,
            completedAt: true,
            recurrence: true
        }
    });

    const data: Record<string, unknown> = {};
    if (input.priority !== undefined) data.priority = input.priority;
    if (input.dueDate !== undefined) data.dueDate = input.dueDate ? new Date(input.dueDate) : null;
    if (input.listId !== undefined) {
        // The destination was cleared with the caller's role on it, and it also
        // has to sit in the same space as everything being moved: Task.spaceId is
        // not being rewritten here, and a task whose list and space disagree drops
        // out of every space-scoped view at once.
        const target = await prisma.taskList.findUnique({
            where: { id: input.listId },
            select: { spaceId: true }
        });
        if (!target) throw new Error("That list no longer exists");
        if (spacesTouched.size > 1 || !spacesTouched.has(target.spaceId)) {
            throw new Error("Tasks can only be moved between lists in their own space");
        }
        data.listId = input.listId;
    }
    if (input.sprintId !== undefined) data.sprintId = input.sprintId;
    if (input.archived !== undefined) data.archived = input.archived;

    // A status belongs to one space and a selection can span several, so the one
    // that was picked is resolved space by space to whatever that space calls it.
    // Resolved for every space before anything is written: a space with nothing
    // by that name refuses the whole change rather than applying it to half the
    // selection. Everything else in `data` is space-agnostic and goes to all.
    const statusPerSpace = new Map<string, { id: string; finished: boolean }>();
    if (input.statusId !== undefined) {
        for (const spaceId of spacesTouched) {
            const status = await statusInSpace(spaceId, input.statusId);
            statusPerSpace.set(spaceId, {
                id: status.id,
                finished: core.isFinishedStatus(status.type as core.TaskStatusType)
            });
        }
    }

    if (statusPerSpace.size > 0) {
        for (const [spaceId, status] of statusPerSpace) {
            const scoped = before.filter((task) => task.spaceId === spaceId);
            const scopedIds = scoped.map((task) => task.id);
            if (scopedIds.length === 0) continue;
            // A task already carrying a completion date keeps it: the stamp says
            // when the work was finished, and re-dating it because somebody set
            // the status of forty rows at once is how a "finished this week"
            // report starts counting last month's work. Unfinished kinds clear it
            // outright, which is what reopening means.
            await prisma.task.updateMany({
                where: { id: { in: scopedIds } },
                data: {
                    ...data,
                    statusId: status.id,
                    ...(status.finished ? {} : { completedAt: null })
                }
            });
            if (status.finished) {
                const unstamped = scoped.filter((task) => task.completedAt === null).map((task) => task.id);
                if (unstamped.length > 0) {
                    await prisma.task.updateMany({
                        where: { id: { in: unstamped } },
                        data: { completedAt: new Date() }
                    });
                }
            }
        }
    } else if (Object.keys(data).length > 0) {
        await prisma.task.updateMany({ where: { id: { in: ids } }, data });
    }

    // createMany's skipDuplicates is Postgres-only and the schema has to stay
    // SQLite-portable, so whatever would collide is removed first. Same result,
    // and adding somebody who is already on the task stays a no-op.
    //
    // Who was already on which task is read first, so "was just handed this" is
    // the people it is actually news to rather than everybody named in the change.
    const handedTo = new Map<string, string[]>();
    if (input.addAssigneeIds?.length) {
        const userIds = input.addAssigneeIds;
        const already = await prisma.taskAssignee.findMany({
            where: { taskId: { in: ids }, userId: { in: userIds } },
            select: { taskId: true, userId: true }
        });
        const held = new Set(already.map((entry) => `${entry.taskId}:${entry.userId}`));
        await prisma.taskAssignee.deleteMany({ where: { taskId: { in: ids }, userId: { in: userIds } } });
        await prisma.taskAssignee.createMany({
            data: ids.flatMap((taskId) => userIds.map((userId) => ({ taskId, userId })))
        });
        for (const taskId of ids) {
            const added = userIds.filter((userId) => !held.has(`${taskId}:${userId}`));
            if (added.length > 0) handedTo.set(taskId, added);
        }
    }
    const takenFrom = new Set<string>();
    if (input.removeAssigneeIds?.length) {
        const holders = await prisma.taskAssignee.findMany({
            where: { taskId: { in: ids }, userId: { in: input.removeAssigneeIds } },
            select: { taskId: true }
        });
        for (const entry of holders) takenFrom.add(entry.taskId);
        await prisma.taskAssignee.deleteMany({
            where: { taskId: { in: ids }, userId: { in: input.removeAssigneeIds } }
        });
    }
    const tagged: string[] = [];
    if (input.addTagIds?.length) {
        const tagIds = input.addTagIds;
        // Which rows the tag is news to, read before the write for the same reason
        // as the assignees: a rule listening for a tag should not fire on the forty
        // rows that already carried it.
        const already = await prisma.taskTagLink.findMany({
            where: { taskId: { in: ids }, tagId: { in: tagIds } },
            select: { taskId: true, tagId: true }
        });
        const held = new Set(already.map((entry) => `${entry.taskId}:${entry.tagId}`));
        await prisma.taskTagLink.deleteMany({ where: { taskId: { in: ids }, tagId: { in: tagIds } } });
        await prisma.taskTagLink.createMany({
            data: ids.flatMap((taskId) => tagIds.map((tagId) => ({ taskId, tagId })))
        });
        for (const taskId of ids) {
            if (tagIds.some((tagId) => !held.has(`${taskId}:${tagId}`))) tagged.push(taskId);
        }
    }
    if (input.removeTagIds?.length) {
        await prisma.taskTagLink.deleteMany({ where: { taskId: { in: ids }, tagId: { in: input.removeTagIds } } });
    }

    // The names a status line needs, for every status either end of the move
    // mentions: one query for the selection rather than two per row.
    const statusNames = new Map<string, string>();
    if (statusPerSpace.size > 0) {
        const wanted = new Set<string>();
        for (const status of statusPerSpace.values()) wanted.add(status.id);
        for (const task of before) if (task.statusId) wanted.add(task.statusId);
        const rows = await prisma.taskStatus.findMany({
            where: { id: { in: [...wanted] } },
            select: { id: true, name: true }
        });
        for (const row of rows) statusNames.set(row.id, row.name);
    }

    const lines: Prisma.TaskActivityCreateManyInput[] = [];
    const statusChanged: string[] = [];
    const completed: string[] = [];
    const priorityChanged: string[] = [];
    const movedList: string[] = [];

    for (const task of before) {
        const status = statusPerSpace.get(task.spaceId);
        const movedTo = status && status.id !== task.statusId ? status : null;
        const line = (action: string, fromValue: string | null = null, toValue: string | null = null) =>
            lines.push({ taskId: task.id, userId: actorId, action, fromValue, toValue });
        const written = lines.length;

        if (movedTo) {
            statusChanged.push(task.id);
            if (movedTo.finished) completed.push(task.id);
            line(
                "status",
                task.statusId ? (statusNames.get(task.statusId) ?? null) : null,
                statusNames.get(movedTo.id) ?? null
            );
        }
        if (input.priority !== undefined && input.priority !== task.priority) {
            priorityChanged.push(task.id);
            line(
                "priority",
                core.TASK_PRIORITY_LABELS[task.priority as core.TaskPriority],
                core.TASK_PRIORITY_LABELS[input.priority]
            );
        }
        if (input.dueDate !== undefined) line("due", task.dueDate?.toISOString() ?? null, input.dueDate ?? null);
        if (input.listId !== undefined && input.listId !== task.listId) {
            movedList.push(task.id);
            line("moved");
        }
        if (input.archived === true) line("archived");
        if (handedTo.has(task.id)) line("assignee", null, String(handedTo.get(task.id)?.length ?? 0));
        else if (takenFrom.has(task.id)) line("assignee");
        // A change with no line of its own - a sprint, a tag - still leaves a
        // mark, which is what this stream is for.
        if (lines.length === written) line("bulk");
    }

    if (lines.length > 0) await prisma.taskActivity.createMany({ data: lines });

    const names = new Map(before.map((task) => [task.id, task.name]));
    await announceHandover(handedTo, names, actorId);

    // Rules last, and only for the rows something happened to. Asked once for
    // the whole selection first: a space with no rules at all is one query rather
    // than two per task.
    const raised: [core.AutomationTrigger, readonly string[]][] = [
        ["task.statusChanged", statusChanged],
        ["task.completed", completed],
        ["task.priorityChanged", priorityChanged],
        ["task.dueDateSet", input.dueDate ? ids : []],
        ["task.moved", movedList],
        ["task.assigneeAdded", [...handedTo.keys()]],
        ["task.assigneeRemoved", [...takenFrom]],
        ["task.tagAdded", tagged]
    ];
    const pending = raised.filter(([, tasks]) => tasks.length > 0);
    const triggers = pending.map(([trigger]) => trigger);
    if (pending.length > 0 && (await hasAutomationsFor([...spacesTouched], triggers))) {
        for (const [trigger, tasks] of pending) {
            await runAutomationsFor({ trigger, taskIds: tasks, actorId });
        }
    }

    // A recurring job that was just finished does not stay finished, whether it
    // was ticked on its own row or with thirty others.
    const recurring = new Set(before.filter((task) => task.recurrence !== null).map((task) => task.id));
    for (const taskId of completed) {
        if (recurring.has(taskId)) await rescheduleIfRecurring(taskId, actorId);
    }

    return ids.length;
}

/**
 * Tell the people a selection was just handed to.
 *
 * One notification each, naming the count, rather than one per task: forty rows
 * changing hands is one decision, and forty lines in somebody's tray is a reason
 * to stop reading the tray. A single task is still announced as itself, since
 * that is the one case where its name and a link to it are the whole message.
 */
async function announceHandover(
    handedTo: ReadonlyMap<string, readonly string[]>,
    names: ReadonlyMap<string, string>,
    actorId: string
): Promise<void> {
    const perPerson = new Map<string, string[]>();
    for (const [taskId, userIds] of handedTo) {
        for (const userId of userIds) {
            if (userId === actorId) continue;
            const held = perPerson.get(userId);
            if (held) held.push(taskId);
            else perPerson.set(userId, [taskId]);
        }
    }

    for (const [userId, taskIds] of perPerson) {
        const first = taskIds[0] as string;
        if (taskIds.length === 1) {
            await announceAssignment(first, names.get(first) ?? "A task", [userId], actorId);
            continue;
        }
        await notify({
            userId,
            event: "tasks.assigned",
            title: `${taskIds.length} tasks assigned to you`,
            body: "You were put on them in one change.",
            href: "/tasks"
        });
    }
}

export async function deleteTask(taskId: string): Promise<void> {
    await prisma.task.delete({ where: { id: taskId } });
}

/** Delete a selection. The ids arrive already narrowed to the tasks the caller
 *  may write, so this is one statement rather than a loop of them; subtasks,
 *  comments and tracked time follow through the schema's cascades either way. */
export async function deleteTasks(taskIds: readonly string[]): Promise<number> {
    if (taskIds.length === 0) return 0;
    const { count } = await prisma.task.deleteMany({ where: { id: { in: [...taskIds] } } });
    return count;
}

/** Duplicate a task, including its checklists. Subtasks come along too, because
 *  a copy that quietly drops half the work is worse than no copy. */
export async function duplicateTask(actorId: string, taskId: string): Promise<string | null> {
    const source = await prisma.task.findUnique({
        where: { id: taskId },
        select: {
            spaceId: true,
            listId: true,
            name: true,
            description: true,
            statusId: true,
            priority: true,
            startDate: true,
            dueDate: true,
            timed: true,
            timeEstimate: true,
            points: true,
            milestone: true,
            parentId: true,
            assignees: { select: { userId: true } },
            tags: { select: { tagId: true } },
            checklists: { select: { name: true, order: true, items: { select: { name: true, order: true } } } },
            subtasks: { select: { name: true, description: true, statusId: true, priority: true } }
        }
    });
    if (!source) return null;

    const created = await createTask(actorId, source.spaceId, {
        listId: source.listId,
        name: `${source.name} (copy)`,
        description: source.description,
        parentId: source.parentId,
        statusId: source.statusId,
        priority: source.priority as core.TaskPriority,
        assigneeIds: source.assignees.map((entry) => entry.userId),
        tagIds: source.tags.map((entry) => entry.tagId),
        startDate: source.startDate?.toISOString() ?? null,
        dueDate: source.dueDate?.toISOString() ?? null,
        timed: source.timed,
        timeEstimate: source.timeEstimate,
        points: source.points,
        sprintId: null,
        milestone: source.milestone,
        recurrence: null
    });

    for (const checklist of source.checklists) {
        await prisma.taskChecklist.create({
            data: {
                taskId: created.id,
                name: checklist.name,
                order: checklist.order,
                items: { create: checklist.items.map((item) => ({ name: item.name, order: item.order })) }
            }
        });
    }
    for (const subtask of source.subtasks) {
        await createTask(actorId, source.spaceId, {
            listId: source.listId,
            name: subtask.name,
            description: subtask.description,
            parentId: created.id,
            statusId: subtask.statusId,
            priority: subtask.priority as core.TaskPriority,
            assigneeIds: [],
            tagIds: [],
            startDate: null,
            dueDate: null,
            timed: false,
            timeEstimate: null,
            points: null,
            sprintId: null,
            milestone: false,
            recurrence: null
        });
    }
    return created.id;
}
