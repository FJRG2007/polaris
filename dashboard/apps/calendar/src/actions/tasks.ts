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
                editable: true
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
