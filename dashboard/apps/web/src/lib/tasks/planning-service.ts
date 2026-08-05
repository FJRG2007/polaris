/**
 * Planning surfaces: sprints and goals.
 *
 * Both answer "are we going to make it", which is why they share a module and a
 * shape: a window of time, a set of work, and a number that either moves or does
 * not. Neither owns any tasks - a sprint is a pointer a task carries and a goal
 * reads finished work out of the lists it watches - so putting work in or taking
 * it out never changes where that work lives.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";

// ---------------------------------------------------------------------------
// Sprints
// ---------------------------------------------------------------------------

export interface SprintView {
    readonly id: string;
    readonly spaceId: string;
    /** The folder whose work this sprint plans, or null for a space-wide one. */
    readonly folderId: string | null;
    readonly folderName: string | null;
    readonly name: string;
    readonly goal: string;
    readonly startDate: string;
    readonly endDate: string;
    readonly status: "planned" | "active" | "completed";
    readonly taskCount: number;
    readonly doneCount: number;
    readonly points: number;
    readonly donePoints: number;
}

/**
 * Every sprint the reader can see, in one query rather than one per space.
 *
 * `folderIds` are the folders reached through a grant in a space the reader does
 * not hold outright, so a contractor invited to one project sees that project's
 * sprints and none of the ones beside it.
 */
export async function listSprints(reach: { spaceIds: string[]; folderIds?: string[] }): Promise<SprintView[]> {
    const folderIds = reach.folderIds ?? [];
    if (reach.spaceIds.length === 0 && folderIds.length === 0) return [];

    const sprints = await prisma.taskSprint.findMany({
        where: { OR: [{ spaceId: { in: reach.spaceIds } }, { folderId: { in: folderIds } }] },
        orderBy: { startDate: "desc" },
        select: {
            id: true,
            spaceId: true,
            folderId: true,
            name: true,
            goal: true,
            startDate: true,
            endDate: true,
            status: true,
            folder: { select: { name: true } },
            tasks: { select: { points: true, status: { select: { type: true } } } }
        }
    });

    return sprints.map((sprint) => {
        const done = sprint.tasks.filter((task) =>
            core.isFinishedStatus((task.status?.type as core.TaskStatusType) ?? "open")
        );
        return {
            id: sprint.id,
            spaceId: sprint.spaceId,
            folderId: sprint.folderId,
            folderName: sprint.folder?.name ?? null,
            name: sprint.name,
            goal: sprint.goal,
            startDate: sprint.startDate.toISOString(),
            endDate: sprint.endDate.toISOString(),
            status: sprint.status as SprintView["status"],
            taskCount: sprint.tasks.length,
            doneCount: done.length,
            points: sprint.tasks.reduce((sum, task) => sum + (task.points ?? 0), 0),
            donePoints: done.reduce((sum, task) => sum + (task.points ?? 0), 0)
        };
    });
}

export async function createSprint(input: core.SprintInput): Promise<string> {
    if (new Date(input.endDate) <= new Date(input.startDate)) {
        throw new Error("A sprint has to end after it starts");
    }
    const sprint = await prisma.taskSprint.create({
        data: {
            spaceId: input.spaceId,
            folderId: input.folderId,
            name: input.name,
            goal: input.goal,
            startDate: new Date(input.startDate),
            endDate: new Date(input.endDate)
        },
        select: { id: true }
    });
    return sprint.id;
}

/** Edits a sprint's own details. It deliberately cannot change which folder the
 *  sprint plans: that is a different sprint, and moving one would silently take
 *  its burndown out from under whoever was reading it. */
export async function updateSprint(sprintId: string, input: Omit<core.SprintInput, "spaceId" | "folderId">): Promise<void> {
    if (new Date(input.endDate) <= new Date(input.startDate)) {
        throw new Error("A sprint has to end after it starts");
    }
    await prisma.taskSprint.update({
        where: { id: sprintId },
        data: {
            name: input.name,
            goal: input.goal,
            startDate: new Date(input.startDate),
            endDate: new Date(input.endDate)
        }
    });
}

/**
 * Move a sprint's state on. Starting one ends whichever sprint was already
 * running beside it, because two sprints at once is a scheduling accident rather
 * than a plan - but only within the same container. A project running its own
 * sprints must not end the sprint of the project in the folder next door.
 */
export async function setSprintStatus(
    spaceId: string,
    sprintId: string,
    status: SprintView["status"]
): Promise<void> {
    if (status === "active") {
        const starting = await prisma.taskSprint.findUnique({
            where: { id: sprintId },
            select: { folderId: true }
        });
        await prisma.taskSprint.updateMany({
            where: { spaceId, folderId: starting?.folderId ?? null, status: "active", id: { not: sprintId } },
            data: { status: "completed" }
        });
    }
    await prisma.taskSprint.update({ where: { id: sprintId }, data: { status } });
}

export async function deleteSprint(sprintId: string): Promise<void> {
    await prisma.taskSprint.delete({ where: { id: sprintId } });
}

export async function setTaskSprint(taskId: string, sprintId: string | null): Promise<void> {
    await prisma.task.update({ where: { id: taskId }, data: { sprintId } });
}

/** The burndown for one sprint, ready to chart. */
export async function sprintBurndown(sprintId: string, now = new Date()): Promise<core.BurndownPoint[]> {
    const sprint = await prisma.taskSprint.findUnique({
        where: { id: sprintId },
        select: {
            startDate: true,
            endDate: true,
            tasks: { select: { points: true, completedAt: true, status: { select: { type: true } } } }
        }
    });
    if (!sprint) return [];
    return core.burndown(
        {
            start: sprint.startDate,
            end: sprint.endDate,
            tasks: sprint.tasks.map((task) => ({
                points: task.points,
                completedAt: task.completedAt,
                statusType: (task.status?.type as core.TaskStatusType) ?? "open"
            }))
        },
        now
    );
}

// ---------------------------------------------------------------------------
// Goals
// ---------------------------------------------------------------------------

export interface GoalTargetView {
    readonly id: string;
    readonly name: string;
    readonly type: core.GoalTargetType;
    readonly startValue: number;
    readonly targetValue: number;
    readonly currentValue: number;
    readonly unit: string;
    readonly listId: string | null;
    readonly percent: number;
}

export interface GoalView {
    readonly id: string;
    readonly name: string;
    readonly description: string;
    readonly spaceId: string | null;
    readonly dueDate: string | null;
    readonly color: string;
    readonly ownerId: string;
    readonly ownerName: string;
    readonly completedAt: string | null;
    readonly targets: GoalTargetView[];
    /** The average of its targets: what the ring on the card fills to. */
    readonly percent: number;
}

/** How far one target has come, clamped so a beaten target reads as done rather
 *  than as 140% of a ring. */
function targetPercent(target: { startValue: number; targetValue: number; currentValue: number }): number {
    const span = target.targetValue - target.startValue;
    if (span === 0) return target.currentValue >= target.targetValue ? 100 : 0;
    return Math.max(0, Math.min(100, Math.round(((target.currentValue - target.startValue) / span) * 100)));
}

export async function listGoals(userId: string, spaceIds: string[]): Promise<GoalView[]> {
    const goals = await prisma.taskGoal.findMany({
        where: { archived: false, OR: [{ ownerId: userId }, { spaceId: { in: spaceIds } }] },
        orderBy: [{ completedAt: "asc" }, { dueDate: "asc" }, { createdAt: "desc" }],
        select: {
            id: true,
            name: true,
            description: true,
            spaceId: true,
            dueDate: true,
            color: true,
            ownerId: true,
            completedAt: true,
            owner: { select: { name: true } },
            targets: { orderBy: { order: "asc" } }
        }
    });

    // A `tasks` target counts finished work in the list it watches, so it is
    // resolved at read time rather than kept current by a write somewhere else.
    const watchedLists = goals.flatMap((goal) =>
        goal.targets.filter((target) => target.type === "tasks" && target.listId).map((target) => target.listId!)
    );
    const counts = new Map<string, { total: number; done: number }>();
    if (watchedLists.length > 0) {
        const grouped = await prisma.task.groupBy({
            by: ["listId"],
            where: { listId: { in: watchedLists }, archived: false },
            _count: { _all: true }
        });
        const finished = await prisma.task.groupBy({
            by: ["listId"],
            where: {
                listId: { in: watchedLists },
                archived: false,
                status: { type: { in: ["done", "closed"] } }
            },
            _count: { _all: true }
        });
        for (const row of grouped) counts.set(row.listId, { total: row._count._all, done: 0 });
        for (const row of finished) {
            const bucket = counts.get(row.listId) ?? { total: 0, done: 0 };
            counts.set(row.listId, { ...bucket, done: row._count._all });
        }
    }

    return goals.map((goal) => {
        const targets = goal.targets.map((target): GoalTargetView => {
            const counted = target.type === "tasks" && target.listId ? counts.get(target.listId) : undefined;
            const resolved = {
                startValue: target.startValue,
                targetValue: counted ? counted.total : target.targetValue,
                currentValue: counted ? counted.done : target.currentValue
            };
            return {
                id: target.id,
                name: target.name,
                type: target.type as core.GoalTargetType,
                unit: target.unit,
                listId: target.listId,
                ...resolved,
                percent: targetPercent(resolved)
            };
        });
        return {
            id: goal.id,
            name: goal.name,
            description: goal.description,
            spaceId: goal.spaceId,
            dueDate: goal.dueDate?.toISOString() ?? null,
            color: goal.color,
            ownerId: goal.ownerId,
            ownerName: goal.owner.name,
            completedAt: goal.completedAt?.toISOString() ?? null,
            targets,
            percent:
                targets.length === 0
                    ? 0
                    : Math.round(targets.reduce((sum, target) => sum + target.percent, 0) / targets.length)
        };
    });
}

export async function createGoal(ownerId: string, input: core.GoalInput): Promise<string> {
    const goal = await prisma.taskGoal.create({
        data: {
            ownerId,
            spaceId: input.spaceId,
            name: input.name,
            description: input.description,
            dueDate: input.dueDate ? new Date(input.dueDate) : null,
            color: input.color
        },
        select: { id: true }
    });
    return goal.id;
}

export async function updateGoal(goalId: string, input: core.GoalInput): Promise<void> {
    await prisma.taskGoal.update({
        where: { id: goalId },
        data: {
            spaceId: input.spaceId,
            name: input.name,
            description: input.description,
            dueDate: input.dueDate ? new Date(input.dueDate) : null,
            color: input.color
        }
    });
}

/**
 * Who a goal answers to: the space it plans for, and the account that created
 * it. An action handed nothing but a goal id has no other way to authorize the
 * write, and a goal with no space is somebody's own rather than a space's.
 */
export async function goalOwner(goalId: string): Promise<{ ownerId: string; spaceId: string | null } | null> {
    return prisma.taskGoal.findUnique({ where: { id: goalId }, select: { ownerId: true, spaceId: true } });
}

/** The same answer for one of a goal's targets, since a target is only ever
 *  written through the goal that holds it. */
export async function goalTargetOwner(
    targetId: string
): Promise<{ goalId: string; ownerId: string; spaceId: string | null } | null> {
    const target = await prisma.taskGoalTarget.findUnique({
        where: { id: targetId },
        select: { goalId: true, goal: { select: { ownerId: true, spaceId: true } } }
    });
    if (!target) return null;
    return { goalId: target.goalId, ownerId: target.goal.ownerId, spaceId: target.goal.spaceId };
}

export async function setGoalCompleted(goalId: string, completed: boolean): Promise<void> {
    await prisma.taskGoal.update({
        where: { id: goalId },
        data: { completedAt: completed ? new Date() : null }
    });
}

export async function deleteGoal(goalId: string): Promise<void> {
    await prisma.taskGoal.delete({ where: { id: goalId } });
}

export async function addGoalTarget(goalId: string, input: core.GoalTargetInput): Promise<void> {
    const last = await prisma.taskGoalTarget.findFirst({
        where: { goalId },
        orderBy: { order: "desc" },
        select: { order: true }
    });
    await prisma.taskGoalTarget.create({
        data: {
            goalId,
            name: input.name,
            type: input.type,
            startValue: input.startValue,
            targetValue: input.targetValue,
            currentValue: input.currentValue,
            unit: input.unit,
            listId: input.listId,
            order: (last?.order ?? 0) + core.ORDER_STEP
        }
    });
}

/** Move a target's number. The only write a `tasks` target ignores, since it
 *  counts its list instead. */
export async function setGoalTargetValue(targetId: string, currentValue: number): Promise<void> {
    await prisma.taskGoalTarget.update({ where: { id: targetId }, data: { currentValue } });
}

export async function deleteGoalTarget(targetId: string): Promise<void> {
    await prisma.taskGoalTarget.delete({ where: { id: targetId } });
}
