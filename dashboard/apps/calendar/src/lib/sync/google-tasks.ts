/**
 * Google Tasks, through the Tasks API v1, beside the account's calendars.
 *
 * Google Calendar draws an account's tasks on their due day; so does Polaris.
 * Each task list is one more calendar of the account, holding VTODOs, so the
 * grid, the "show tasks" setting, ticking one off and the sync engine treat
 * them as they treat a CalDAV server's tasks. Its remote id is the list's id
 * behind `tasks:`, which no Calendar API id starts with.
 *
 * Google keeps a task's `due` as a date only - the time is dropped when it is
 * written and cannot be read (https://developers.google.com/workspace/tasks/
 * reference/rest/v1/tasks) - so a task here is due on a day, all day, and one
 * given a time here is sent as its day.
 *
 * A pull of a list asks for everything the first time and then only what
 * changed since the newest `updated` it saw (`updatedMin`, with deletions), so
 * an account with years of finished tasks is read whole once.
 *
 * Every answer is checked against a schema before it is read.
 */

import { z } from "zod";
import * as bridge from "./bridge";
import type * as types from "../../engine/types";
import type { ChangeSet, PullState, RemoteCalendar, RemoteObject } from "./provider";

export const GOOGLE_TASKS_API = "https://tasks.googleapis.com/tasks/v1";

/** What a task list's remote id starts with. */
export const TASKS_PREFIX = "tasks:";

/** The Google list a calendar's remote id names, or null for a calendar. */
export function taskListOf(remoteId: string): string | null {
    return remoteId.startsWith(TASKS_PREFIX) ? remoteId.slice(TASKS_PREFIX.length) : null;
}

const TaskList = z.object({
    id: z.string().min(1),
    title: z.string().optional(),
    updated: z.string().optional()
});

export const TaskListsPage = z.object({
    items: z.array(TaskList).optional(),
    nextPageToken: z.string().optional()
});

export const GoogleTask = z.object({
    id: z.string().min(1),
    etag: z.string().optional(),
    title: z.string().optional(),
    notes: z.string().optional(),
    status: z.string().optional(),
    due: z.string().optional(),
    completed: z.string().optional(),
    updated: z.string().optional(),
    deleted: z.boolean().optional(),
    hidden: z.boolean().optional()
});

export type GoogleTaskJson = z.infer<typeof GoogleTask>;

export const TasksPage = z.object({
    items: z.array(GoogleTask).optional(),
    nextPageToken: z.string().optional()
});

/** One task list as a calendar of the account. */
export function taskListCalendar(list: z.infer<typeof TaskList>): RemoteCalendar {
    return {
        remoteId: `${TASKS_PREFIX}${list.id}`,
        name: list.title?.trim() || "Tasks",
        color: null,
        description: "",
        timezone: null,
        readOnly: false,
        components: ["VTODO"]
    };
}

/** The day a Google `due` names: its date part, which is all Google keeps. */
function dueDay(due: string | undefined): types.DateOnly | null {
    const day = /^(\d{4}-\d{2}-\d{2})/.exec(due ?? "")?.[1];
    return day ? { date: day } : null;
}

/** The UID a Google task is stored under. */
export function taskUid(taskId: string): string {
    return `${taskId}@tasks.google.com`;
}

/** One Google task as an engine task: due on a day, done or not. */
export function googleTaskToTodo(task: GoogleTaskJson): types.CalendarTodo {
    const done = task.status === "completed";
    return {
        uid: taskUid(task.id),
        summary: task.title ?? "",
        description: task.notes ?? "",
        start: null,
        due: dueDay(task.due),
        completed: done ? bridge.stampOf(task.completed ?? task.updated) : null,
        status: done ? "COMPLETED" : "NEEDS-ACTION",
        percent: done ? 100 : 0,
        priority: 0,
        categories: [],
        alarms: [],
        rule: null,
        extra: [],
        extraComponents: []
    };
}

/** One Google task as the object the engine stores. */
export function googleTaskToObject(task: GoogleTaskJson): RemoteObject {
    const todo = googleTaskToTodo(task);
    return {
        href: task.id,
        etag: task.etag ?? task.updated ?? "",
        ics: bridge.writeItem({
            component: "VTODO",
            uid: todo.uid,
            todo,
            timezones: [],
            method: null
        })
    };
}

/** The day a task is due on, as Google takes it: midnight UTC of that day. */
function googleDue(due: types.DateValue | null): string | null {
    if (!due) return null;
    const day = bridge.isDate(due) ? due.date : due.dateTime.slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(day) ? `${day}T00:00:00.000Z` : null;
}

/**
 * An engine task as the body of a Tasks API insert or patch. `null` clears a
 * field on a patch: a due day taken away, a done task opened again.
 */
export function todoToGoogleTask(todo: types.CalendarTodo): Record<string, unknown> {
    const done = todo.status === "COMPLETED";
    return {
        title: todo.summary.slice(0, 1024),
        notes: todo.description.slice(0, 8192),
        status: done ? "completed" : "needsAction",
        due: googleDue(todo.due),
        ...(done ? {} : { completed: null })
    };
}

/** The newest `updated` among these tasks, or the one before when none is newer. */
function newest(tasks: readonly GoogleTaskJson[], previous: string): string {
    let best = previous;
    for (const task of tasks) {
        if (!task.updated || Number.isNaN(Date.parse(task.updated))) continue;
        if (!best || Date.parse(task.updated) > Date.parse(best)) best = task.updated;
    }
    return best;
}

/**
 * A list's changes since `state`, from every page `listTasks` reads. The sync
 * token is the newest `updated` seen: Google's own clock, not this server's.
 */
export async function pullTaskList(
    state: PullState,
    listTasks: (query: Record<string, string>) => Promise<GoogleTaskJson[]>
): Promise<ChangeSet> {
    const since = state.syncToken && !Number.isNaN(Date.parse(state.syncToken));
    const tasks = await listTasks({
        showCompleted: "true",
        // Done in Google's own apps, a task is hidden until shown on purpose.
        showHidden: "true",
        showDeleted: since ? "true" : "false",
        ...(since ? { updatedMin: state.syncToken } : {})
    });
    const changed: RemoteObject[] = [];
    const removed: string[] = [];
    for (const task of tasks) {
        if (task.deleted) removed.push(task.id);
        else changed.push(googleTaskToObject(task));
    }
    return {
        changed: since
            ? changed.filter((object) => state.known.get(object.href) !== object.etag)
            : changed,
        removed,
        syncToken: newest(tasks, since ? state.syncToken : ""),
        ctag: "",
        full: !since
    };
}
