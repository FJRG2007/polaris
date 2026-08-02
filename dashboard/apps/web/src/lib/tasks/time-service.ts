/**
 * Tracked time: the running timer, manual entries, and the weekly sheet.
 *
 * One rule shapes the whole module: a person has at most one timer going. A
 * second start stops the first rather than running two, because the alternative
 * is a day that adds up to fourteen hours and a timesheet nobody trusts.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { scopeTaskWhere, type TaskScope } from "./access";

export interface RunningTimer {
    readonly entryId: string;
    readonly taskId: string;
    readonly taskName: string;
    readonly reference: string;
    readonly startedAt: string;
    /** Seconds elapsed when the page was rendered; the client counts on from it. */
    readonly elapsed: number;
}

/** The timer this person has going, if any. */
export async function runningTimer(userId: string, now = new Date()): Promise<RunningTimer | null> {
    const entry = await prisma.taskTimeEntry.findFirst({
        where: { userId, endedAt: null },
        orderBy: { startedAt: "desc" },
        select: {
            id: true,
            startedAt: true,
            taskId: true,
            task: { select: { name: true, number: true, space: { select: { prefix: true } } } }
        }
    });
    if (!entry) return null;
    return {
        entryId: entry.id,
        taskId: entry.taskId,
        taskName: entry.task.name,
        reference: core.taskReference(entry.task.space.prefix, entry.task.number),
        startedAt: entry.startedAt.toISOString(),
        elapsed: Math.max(0, Math.floor((now.getTime() - entry.startedAt.getTime()) / 1000))
    };
}

/** Start timing a task, closing whatever was already running. */
export async function startTimer(userId: string, taskId: string): Promise<void> {
    await stopTimer(userId);
    await prisma.taskTimeEntry.create({ data: { userId, taskId, startedAt: new Date() } });
}

/** Stop the running timer and write the seconds it accounted for. An entry that
 *  rounds to nothing is discarded rather than stored as a zero-length row. */
export async function stopTimer(userId: string, now = new Date()): Promise<number> {
    const entry = await prisma.taskTimeEntry.findFirst({
        where: { userId, endedAt: null },
        orderBy: { startedAt: "desc" },
        select: { id: true, startedAt: true }
    });
    if (!entry) return 0;

    const seconds = Math.max(0, Math.floor((now.getTime() - entry.startedAt.getTime()) / 1000));
    if (seconds < 1) {
        await prisma.taskTimeEntry.delete({ where: { id: entry.id } });
        return 0;
    }
    await prisma.taskTimeEntry.update({ where: { id: entry.id }, data: { endedAt: now, seconds } });
    return seconds;
}

export async function addTimeEntry(userId: string, input: core.TimeEntryInput): Promise<void> {
    const startedAt = input.startedAt ? new Date(input.startedAt) : new Date();
    await prisma.taskTimeEntry.create({
        data: {
            userId,
            taskId: input.taskId,
            startedAt,
            endedAt: new Date(startedAt.getTime() + input.duration * 1000),
            seconds: input.duration,
            note: input.note,
            billable: input.billable
        }
    });
}

export async function deleteTimeEntry(userId: string, entryId: string, canModerate: boolean): Promise<void> {
    const deleted = await prisma.taskTimeEntry.deleteMany({
        where: canModerate ? { id: entryId } : { id: entryId, userId }
    });
    if (deleted.count === 0) throw new Error("You can only remove your own entries");
}

// ---------------------------------------------------------------------------
// Timesheets
// ---------------------------------------------------------------------------

export interface TimesheetEntry {
    readonly taskId: string;
    readonly reference: string;
    readonly taskName: string;
    readonly listName: string;
    readonly spaceName: string;
    readonly billable: boolean;
    /** Seconds per day of the week, Monday first. */
    readonly days: number[];
    readonly total: number;
}

export interface Timesheet {
    readonly from: string;
    readonly to: string;
    readonly entries: TimesheetEntry[];
    readonly dayTotals: number[];
    readonly total: number;
    readonly billable: number;
}

/**
 * One person's week, task by task. Rows are keyed by task and billability, so a
 * task with both billable and unbillable time shows the split instead of hiding
 * it in a single number an invoice cannot use.
 */
export async function weeklyTimesheet(userId: string, anchor: Date, scope: TaskScope): Promise<Timesheet> {
    const from = core.startOfWeek(anchor);
    const to = core.endOfDay(core.addDays(from, 6));

    const entries = await prisma.taskTimeEntry.findMany({
        where: {
            userId,
            startedAt: { gte: from, lte: to },
            task: scopeTaskWhere(scope)
        },
        select: {
            seconds: true,
            billable: true,
            startedAt: true,
            taskId: true,
            task: {
                select: {
                    name: true,
                    number: true,
                    list: { select: { name: true } },
                    space: { select: { name: true, prefix: true } }
                }
            }
        }
    });

    const rows = new Map<string, TimesheetEntry & { days: number[] }>();
    const dayTotals = [0, 0, 0, 0, 0, 0, 0];
    let billable = 0;

    for (const entry of entries) {
        const key = `${entry.taskId}:${entry.billable}`;
        const row =
            rows.get(key) ??
            ({
                taskId: entry.taskId,
                reference: core.taskReference(entry.task.space.prefix, entry.task.number),
                taskName: entry.task.name,
                listName: entry.task.list.name,
                spaceName: entry.task.space.name,
                billable: entry.billable,
                days: [0, 0, 0, 0, 0, 0, 0],
                total: 0
            } as TimesheetEntry & { days: number[] });

        const index = Math.min(6, Math.max(0, core.daysBetween(from, entry.startedAt)));
        row.days[index] = (row.days[index] ?? 0) + entry.seconds;
        rows.set(key, { ...row, total: row.total + entry.seconds });
        dayTotals[index] = (dayTotals[index] ?? 0) + entry.seconds;
        if (entry.billable) billable += entry.seconds;
    }

    const list = [...rows.values()].sort((left, right) => right.total - left.total);
    return {
        from: from.toISOString(),
        to: to.toISOString(),
        entries: list,
        dayTotals,
        total: dayTotals.reduce((sum, value) => sum + value, 0),
        billable
    };
}

/** Time logged across a set of spaces in a window, by person. Feeds the report
 *  screen without pulling every entry into the page. */
export async function timeByPerson(
    scope: TaskScope,
    from: Date,
    to: Date
): Promise<{ userId: string; name: string; seconds: number }[]> {
    const grouped = await prisma.taskTimeEntry.groupBy({
        by: ["userId"],
        where: { startedAt: { gte: from, lte: to }, task: scopeTaskWhere(scope) },
        _sum: { seconds: true }
    });
    if (grouped.length === 0) return [];

    const users = await prisma.user.findMany({
        where: { id: { in: grouped.map((row) => row.userId) } },
        select: { id: true, name: true }
    });
    const names = new Map(users.map((user) => [user.id, user.name]));
    return grouped
        .map((row) => ({
            userId: row.userId,
            name: names.get(row.userId) ?? "Somebody",
            seconds: row._sum.seconds ?? 0
        }))
        .sort((left, right) => right.seconds - left.seconds);
}
