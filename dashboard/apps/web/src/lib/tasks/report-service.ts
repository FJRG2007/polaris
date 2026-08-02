/**
 * The numbers the reporting screen draws.
 *
 * Everything here is an aggregate computed in the database rather than a scan in
 * application code: a workspace with fifty thousand tasks should still render a
 * dashboard, and pulling the rows back to count them in JavaScript is how that
 * stops being true.
 */

import * as core from "@polaris/core";
import { prisma, type Prisma } from "@polaris/db";

export interface ReportSummary {
    readonly total: number;
    readonly open: number;
    readonly done: number;
    readonly overdue: number;
    readonly dueThisWeek: number;
    readonly completedThisWeek: number;
    readonly trackedThisWeek: number;
}

export interface StatusSlice {
    readonly id: string;
    readonly name: string;
    readonly color: string;
    readonly count: number;
}

export interface PersonLoad {
    readonly userId: string;
    readonly name: string;
    readonly open: number;
    readonly overdue: number;
    readonly points: number;
}

export interface CompletionPoint {
    readonly date: string;
    readonly completed: number;
}

export interface TaskReport {
    readonly summary: ReportSummary;
    readonly byStatus: StatusSlice[];
    readonly byPriority: { priority: core.TaskPriority; count: number }[];
    readonly load: PersonLoad[];
    readonly completion: CompletionPoint[];
}

/** The whole reporting page for a set of spaces, in one pass. */
export async function buildReport(spaceIds: string[], now = new Date()): Promise<TaskReport> {
    if (spaceIds.length === 0) {
        return {
            summary: {
                total: 0,
                open: 0,
                done: 0,
                overdue: 0,
                dueThisWeek: 0,
                completedThisWeek: 0,
                trackedThisWeek: 0
            },
            byStatus: [],
            byPriority: [],
            load: [],
            completion: []
        };
    }

    const weekStart = core.startOfWeek(now);
    const weekEnd = core.endOfDay(core.addDays(weekStart, 6));
    const scope: Prisma.TaskWhereInput = { spaceId: { in: spaceIds }, archived: false };
    const finishedTypes: Prisma.TaskWhereInput = { status: { type: { in: ["done", "closed"] } } };
    // A task with no status at all is still outstanding, so the "not finished"
    // filter has to say so explicitly rather than relying on the join.
    const unfinished: Prisma.TaskWhereInput = {
        OR: [{ status: null }, { status: { type: { in: ["open", "active"] } } }]
    };

    const [total, done, overdue, dueThisWeek, completedThisWeek, tracked, statuses, priorities, completion] =
        await Promise.all([
            prisma.task.count({ where: scope }),
            prisma.task.count({ where: { ...scope, ...finishedTypes } }),
            prisma.task.count({ where: { ...scope, ...unfinished, dueDate: { lt: core.startOfDay(now) } } }),
            prisma.task.count({ where: { ...scope, dueDate: { gte: weekStart, lte: weekEnd } } }),
            prisma.task.count({ where: { ...scope, completedAt: { gte: weekStart, lte: weekEnd } } }),
            prisma.taskTimeEntry.aggregate({
                where: { startedAt: { gte: weekStart, lte: weekEnd }, task: { spaceId: { in: spaceIds } } },
                _sum: { seconds: true }
            }),
            prisma.task.groupBy({ by: ["statusId"], where: scope, _count: { _all: true } }),
            prisma.task.groupBy({ by: ["priority"], where: { ...scope, ...unfinished }, _count: { _all: true } }),
            prisma.task.findMany({
                where: { ...scope, completedAt: { gte: core.addDays(core.startOfDay(now), -29) } },
                select: { completedAt: true }
            })
        ]);

    const statusRows = await prisma.taskStatus.findMany({
        where: { spaceId: { in: spaceIds } },
        orderBy: { order: "asc" },
        select: { id: true, name: true, color: true }
    });
    const statusCounts = new Map(statuses.map((row) => [row.statusId ?? "", row._count._all]));

    // A workspace with several spaces has several statuses called "Done"; the
    // chart reads better with one slice per name than with five identical ones.
    const byName = new Map<string, StatusSlice>();
    for (const status of statusRows) {
        const count = statusCounts.get(status.id) ?? 0;
        if (count === 0) continue;
        const existing = byName.get(status.name);
        byName.set(
            status.name,
            existing
                ? { ...existing, count: existing.count + count }
                : { id: status.id, name: status.name, color: status.color, count }
        );
    }

    const days = new Map<string, number>();
    for (let index = 29; index >= 0; index -= 1) {
        days.set(core.startOfDay(core.addDays(now, -index)).toISOString(), 0);
    }
    for (const task of completion) {
        if (!task.completedAt) continue;
        const key = core.startOfDay(task.completedAt).toISOString();
        if (days.has(key)) days.set(key, (days.get(key) ?? 0) + 1);
    }

    return {
        summary: {
            total,
            open: total - done,
            done,
            overdue,
            dueThisWeek,
            completedThisWeek,
            trackedThisWeek: tracked._sum.seconds ?? 0
        },
        byStatus: [...byName.values()].sort((left, right) => right.count - left.count),
        byPriority: priorities
            .map((row) => ({ priority: row.priority as core.TaskPriority, count: row._count._all }))
            .sort((left, right) => core.priorityRank(left.priority) - core.priorityRank(right.priority)),
        load: await workload(spaceIds, now),
        completion: [...days.entries()].map(([date, completed]) => ({ date, completed }))
    };
}

/** Who is carrying what, counted from the assignee table so a task with two
 *  owners appears on both of their rows. */
async function workload(spaceIds: string[], now: Date): Promise<PersonLoad[]> {
    const assignments = await prisma.taskAssignee.findMany({
        where: {
            task: {
                spaceId: { in: spaceIds },
                archived: false,
                OR: [{ status: null }, { status: { type: { in: ["open", "active"] } } }]
            }
        },
        select: {
            userId: true,
            task: { select: { dueDate: true, points: true } },
            user: { select: { name: true } }
        }
    });

    const rows = new Map<string, PersonLoad>();
    const today = core.startOfDay(now);
    for (const assignment of assignments) {
        const current = rows.get(assignment.userId) ?? {
            userId: assignment.userId,
            name: assignment.user.name,
            open: 0,
            overdue: 0,
            points: 0
        };
        rows.set(assignment.userId, {
            ...current,
            open: current.open + 1,
            overdue: current.overdue + (assignment.task.dueDate && assignment.task.dueDate < today ? 1 : 0),
            points: current.points + (assignment.task.points ?? 0)
        });
    }
    return [...rows.values()].sort((left, right) => right.open - left.open);
}

/** What one person has on right now, for the home screen headline. */
export async function myWorkCounts(userId: string, spaceIds: string[], now = new Date()): Promise<{
    assigned: number;
    overdue: number;
    dueToday: number;
}> {
    if (spaceIds.length === 0) return { assigned: 0, overdue: 0, dueToday: 0 };
    const mine: Prisma.TaskWhereInput = {
        spaceId: { in: spaceIds },
        archived: false,
        assignees: { some: { userId } },
        OR: [{ status: null }, { status: { type: { in: ["open", "active"] } } }]
    };

    const [assigned, overdue, dueToday] = await Promise.all([
        prisma.task.count({ where: mine }),
        prisma.task.count({ where: { ...mine, dueDate: { lt: core.startOfDay(now) } } }),
        prisma.task.count({
            where: { ...mine, dueDate: { gte: core.startOfDay(now), lte: core.endOfDay(now) } }
        })
    ]);
    return { assigned, overdue, dueToday };
}
