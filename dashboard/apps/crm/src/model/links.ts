/**
 * What a CRM record is linked to in Polaris's other apps - notes, tasks, Drive
 * files - and the shapes the record page draws them in.
 *
 * Pure and client-safe.
 */

import { z } from "zod";

export const LINK_KINDS = ["note", "task", "file"] as const;
export type LinkKind = (typeof LINK_KINDS)[number];

/** The most links of one kind a record page lists. */
export const LINK_PAGE = 50;

export const NOTE_TITLE_MAX = 200;
export const NOTE_BODY_MAX = 20_000;
export const TASK_NAME_MAX = 500;

export interface LinkedNote {
    readonly id: string;
    readonly title: string;
    readonly excerpt: string;
    readonly updatedAt: string;
}

export interface LinkedTask {
    readonly id: string;
    readonly name: string;
    readonly reference: string;
    readonly due: string | null;
    readonly done: boolean;
    readonly listName: string;
}

export interface NoteShelf {
    /** Null is the reader's own notes. */
    readonly id: string | null;
    readonly name: string;
}

export interface TaskList {
    readonly id: string;
    readonly name: string;
    readonly spaceName: string;
}

export interface RecordActivities {
    /** Null when the reader may not use Notes. */
    readonly notes: LinkedNote[] | null;
    readonly noteShelves: NoteShelf[];
    /** Null when the reader may not read Tasks. */
    readonly tasks: LinkedTask[] | null;
    /** Empty when the reader may not create tasks. */
    readonly taskLists: TaskList[];
}

const text = (max: number) => z.string().trim().max(max);

/** A note written from a record. The same rules on the screen and the server. */
export const newNoteSchema = z.object({
    title: text(NOTE_TITLE_MAX).min(1),
    body: text(NOTE_BODY_MAX).default(""),
    spaceId: z.string().uuid().nullable()
});

/** A task made from a record; `due` is a day, `YYYY-MM-DD`. */
export const newTaskSchema = z.object({
    name: text(TASK_NAME_MAX).min(1),
    listId: z.string().uuid(),
    due: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .refine((day) => {
            const at = new Date(`${day}T00:00:00Z`);
            return !Number.isNaN(at.getTime()) && at.toISOString().startsWith(day);
        })
        .nullable()
        .default(null)
});

/** A day as the moment Tasks stores an all-day due date at. */
export function dueAt(day: string | null): { at: string; timed: false } | null {
    return day ? { at: new Date(`${day}T00:00:00Z`).toISOString(), timed: false } : null;
}
