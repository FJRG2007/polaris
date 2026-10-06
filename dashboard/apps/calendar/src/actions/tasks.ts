"use server";

/**
 * Tasks on the calendar. Work from the Tasks app is scheduled through the
 * Tasks service (its history and automations see the change as their own);
 * a task that lives in a calendar (a VTODO synced from outside) is edited here.
 */

import { z } from "zod";
import * as engine from "../engine";
import { host } from "@polaris/app-host";
import { isKnownZone, uuidSchema } from "../lib/schemas";
import type { TaskItemView } from "../lib/wire";
import { requireCalendarUser } from "../lib/access";
import { CalendarRefusal } from "../lib/errors";
import { invalid, outcome, type Outcome } from "../lib/outcome";
import { itemOf, writableObject, writeItem } from "../lib/objects";

/** Tasks assigned to the reader with no due date, for the panel they are
 *  dragged from onto the grid. */
export async function unscheduledTasksAction(): Promise<Outcome<{ tasks: TaskItemView[] }>> {
    return outcome(async () => {
        const user = await requireCalendarUser();
        const tasks = await host.calendarHost.assignedTasks(user.id, "unscheduled", 100);
        return {
            tasks: tasks.map((task) => ({
                source: "tasks" as const,
                id: task.id,
                calendarId: null,
                title: task.name,
                due: null,
                allDay: true,
                done: task.done,
                reference: task.reference,
                listName: task.listName,
                editable: true,
                statusType: task.statusType,
                statusColor: task.statusColor,
                statusName: task.statusName
            }))
        };
    });
}

const scheduleInput = z.object({
    taskId: uuidSchema,
    due: z.object({ at: z.string().datetime({ offset: true }), timed: z.boolean() }).nullable()
});

/** Give a Tasks task a due date, or take it away. */
export async function scheduleTaskAction(input: unknown): Promise<Outcome<object>> {
    const parsed = scheduleInput.safeParse(input);
    if (!parsed.success) return invalid(parsed.error.issues);
    return outcome(async () => {
        const user = await requireCalendarUser();
        await host.calendarHost.scheduleTask(
            { id: user.id, isAdmin: user.isAdmin },
            parsed.data.taskId,
            parsed.data.due
        );
        return {};
    });
}

/** A Tasks list a new task can go into. */
export interface TaskListOption {
    readonly id: string;
    readonly name: string;
    readonly spaceName: string;
}

/** The Tasks lists the reader may add work to, or null when they cannot create
 *  tasks at all - the calendar then offers no way to. */
export async function taskListsAction(): Promise<Outcome<{ lists: TaskListOption[] | null }>> {
    return outcome(async () => {
        const user = await requireCalendarUser();
        return {
            lists: await host.calendarHost.taskListsFor({ id: user.id, isAdmin: user.isAdmin })
        };
    });
}

const createTaskInput = z.object({
    listId: uuidSchema,
    name: z.string().trim().min(1).max(500),
    due: z.object({ at: z.string().datetime({ offset: true }), timed: z.boolean() })
});

/** A Tasks task due at a moment chosen on the calendar, assigned to the reader. */
export async function createDueTaskAction(
    input: unknown
): Promise<Outcome<{ taskId: string; reference: string }>> {
    const parsed = createTaskInput.safeParse(input);
    if (!parsed.success) return invalid(parsed.error.issues);
    return outcome(async () => {
        const user = await requireCalendarUser();
        const created = await host.calendarHost.createDueTask(
            { id: user.id, isAdmin: user.isAdmin },
            parsed.data
        );
        if ("refused" in created) throw new CalendarRefusal(created.refused);
        return { taskId: created.id, reference: created.reference };
    });
}

const todoInput = z.object({
    objectId: uuidSchema,
    version: z.string().datetime(),
    summary: z.string().trim().min(1).max(500),
    due: engine.dateValueSchema.nullable(),
    status: z.enum(["NEEDS-ACTION", "IN-PROCESS", "COMPLETED", "CANCELLED"]),
    zone: z.string().max(64).refine(isKnownZone)
});

/** Change a task that lives in a calendar: its title, when it is due, whether it is done. */
export async function saveTodoAction(input: unknown): Promise<Outcome<object>> {
    const parsed = todoInput.safeParse(input);
    if (!parsed.success) return invalid(parsed.error.issues);
    return outcome(async () => {
        const user = await requireCalendarUser();
        const { row } = await writableObject(user, parsed.data.objectId, parsed.data.version);
        const item = await itemOf(row);
        if (item.component !== "VTODO") return {};
        const done = parsed.data.status === "COMPLETED";
        const todo: engine.CalendarTodo = {
            ...item.todo,
            summary: parsed.data.summary,
            due: parsed.data.due,
            status: parsed.data.status,
            percent: done ? 100 : item.todo.percent === 100 ? 0 : item.todo.percent,
            completed: done ? (item.todo.completed ?? new Date().toISOString()) : null
        };
        await writeItem(
            row.calendarId,
            row,
            { ...item, todo },
            { actor: user, floatingZone: parsed.data.zone }
        );
        return {};
    });
}

const doneInput = z.object({
    source: z.enum(["calendar", "tasks"]),
    id: uuidSchema,
    done: z.boolean(),
    zone: z.string().max(64).refine(isKnownZone)
});

/**
 * Tick a task off, or back, from its mark on the grid - as the round mark on a
 * Tasks row does. A calendar's task is marked completed (or needing action) in
 * its own calendar, which a synced one carries back to its provider; a Tasks
 * task goes through the Tasks service, to the first done (or not started)
 * status of its space.
 */
export async function setTaskDoneAction(input: unknown): Promise<Outcome<object>> {
    const parsed = doneInput.safeParse(input);
    if (!parsed.success) return invalid(parsed.error.issues);
    return outcome(async () => {
        const user = await requireCalendarUser();
        if (parsed.data.source === "tasks") {
            await host.calendarHost.setTaskDone(
                { id: user.id, isAdmin: user.isAdmin },
                parsed.data.id,
                parsed.data.done
            );
            return {};
        }
        const { row } = await writableObject(user, parsed.data.id);
        const item = await itemOf(row);
        if (item.component !== "VTODO") return {};
        const done = parsed.data.done;
        if ((item.todo.status === "COMPLETED") === done) return {};
        const todo: engine.CalendarTodo = {
            ...item.todo,
            status: done ? "COMPLETED" : "NEEDS-ACTION",
            percent: done ? 100 : item.todo.percent === 100 ? 0 : item.todo.percent,
            completed: done ? new Date().toISOString() : null
        };
        await writeItem(
            row.calendarId,
            row,
            { ...item, todo },
            { actor: user, floatingZone: parsed.data.zone }
        );
        return {};
    });
}
