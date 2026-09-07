"use client";

/**
 * A task somebody started writing and did not finish.
 *
 * The create dialog closes when you press outside it, which is what a dialog
 * does - and that once threw away everything typed into it. A name, a
 * description, three tags and a due date is several minutes of somebody's
 * attention, and losing it to a stray click is the kind of thing people
 * remember about a tool. A stray click is not the only way, either: the tab is
 * closed, the browser falls over, the screen under the dialog re-renders and
 * takes it down with it. So the dialog writes here as it is typed rather than
 * when it is dismissed, and none of those cost anything.
 *
 * A draft is kept in this browser and nowhere else: it belongs to the person
 * who typed it, on the machine they typed it on, and it is not worth a row, a
 * sync or a second place for half-written work to leak out of. `localStorage` is
 * therefore right rather than a compromise - and every read of it is guarded,
 * because a private window, cleared site data or a browser that blocks storage
 * all make it throw rather than return nothing.
 *
 * One draft per list, keyed by it: two lists are two different pieces of work,
 * and a draft restored into the wrong one would be worse than no draft.
 *
 * What comes back out is checked rather than trusted. It is whatever was in this
 * browser's storage - written by a build that has since been replaced, or by
 * nothing at all - and a dialog handed a field it did not expect crashes on the
 * way to drawing the draft it was trying to rescue.
 */

import { z } from "zod";

/** What is kept, which is the fields somebody actually fills in before saving.
 *  Anything a task can hold that needs the task to exist is not offered by the
 *  dialog and so is not here either. */
export interface TaskDraft {
    readonly name: string;
    readonly description: string;
    readonly listId: string;
    readonly statusId: string | null;
    readonly priority: string;
    readonly dueDate: string | null;
    readonly startDate: string | null;
    readonly assigneeIds: readonly string[];
    readonly tagIds: readonly string[];
    readonly points: number | null;
    /** When it was put down, so a draft nobody came back to can be dropped. */
    readonly at: number;
}

/** The shape as it is read back. Everything but the name and the moment has a
 *  stand-in, so a draft written before a field existed still opens. */
const storedDraft = z.object({
    name: z.string(),
    description: z.string().catch(""),
    listId: z.string().catch(""),
    statusId: z.string().nullable().catch(null),
    priority: z.string().catch("none"),
    dueDate: z.string().nullable().catch(null),
    startDate: z.string().nullable().catch(null),
    assigneeIds: z.array(z.string()).catch([]),
    tagIds: z.array(z.string()).catch([]),
    points: z.number().nullable().catch(null),
    at: z.number()
});

/** How long a forgotten draft is kept. Long enough to survive a closed laptop,
 *  short enough that a name typed a month ago does not reappear as a surprise. */
const KEEP_FOR_MS = 14 * 24 * 60 * 60 * 1000;

function keyFor(listId: string): string {
    return `polaris:task-draft:${listId || "any"}`;
}

/** The draft for a list, if there is one and it is still current. */
export function readTaskDraft(listId: string): TaskDraft | null {
    try {
        const raw = window.localStorage.getItem(keyFor(listId));
        if (!raw) return null;
        const parsed = storedDraft.safeParse(JSON.parse(raw));
        if (!parsed.success) return null;
        if (Date.now() - parsed.data.at > KEEP_FOR_MS) {
            clearTaskDraft(listId);
            return null;
        }
        return parsed.data;
    } catch {
        // A private window, cleared site data, or a browser told to block
        // storage. No draft is a perfectly good answer.
        return null;
    }
}

export function writeTaskDraft(draft: TaskDraft): void {
    try {
        window.localStorage.setItem(keyFor(draft.listId), JSON.stringify({ ...draft, at: Date.now() }));
    } catch {
        // Nothing to say: the draft is in the dialog the person is looking at.
    }
}

export function clearTaskDraft(listId: string): void {
    try {
        window.localStorage.removeItem(keyFor(listId));
    } catch {
        // Already gone, as far as anybody can tell.
    }
}

/** Whether a draft holds anything worth asking about. A dialog opened and closed
 *  without typing must not put a question in the way. */
export function draftHasContent(draft: Omit<TaskDraft, "at">, defaultName: string): boolean {
    return (
        draft.name.trim() !== defaultName.trim() ||
        draft.description.trim().length > 0 ||
        draft.assigneeIds.length > 0 ||
        draft.tagIds.length > 0 ||
        draft.dueDate !== null ||
        draft.startDate !== null ||
        draft.points !== null ||
        draft.priority !== "none"
    );
}
