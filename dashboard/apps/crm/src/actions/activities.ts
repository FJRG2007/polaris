"use server";

/**
 * The record page's notes and tasks: read them, write one, tick one off, take
 * one off the record. Every input is checked against its schema here, and
 * every rule about who may do what is in `lib/`.
 */

import { z } from "zod";
import * as links from "../lib/links";
import * as activities from "../lib/activities";
import { requireCrmActor } from "../lib/access";
import { CRM_OBJECTS } from "../model/objects";
import { invalid, outcome, type Outcome } from "../lib/outcome";
import {
    LINK_KINDS,
    driveFileSchema,
    newNoteSchema,
    newTaskSchema,
    type LinkedFile,
    type LinkedNote,
    type LinkedTask,
    type RecordActivities
} from "../model/links";

const record = z.object({ object: z.enum(CRM_OBJECTS), id: z.string().uuid() });

/** What a record's notes and tasks are, and where more can go. */
export async function recordActivitiesAction(
    input: unknown
): Promise<Outcome<{ activities: RecordActivities }>> {
    const parsed = record.safeParse(input);
    if (!parsed.success) return invalid();
    return outcome(async () => ({
        activities: await activities.openActivities(
            await requireCrmActor(),
            parsed.data.object,
            parsed.data.id
        )
    }));
}

/** Write a note on a record. */
export async function createRecordNoteAction(
    input: unknown
): Promise<Outcome<{ note: LinkedNote }>> {
    const parsed = record.extend({ note: newNoteSchema }).safeParse(input);
    if (!parsed.success) return invalid();
    return outcome(async () => ({
        note: await activities.createRecordNote(
            await requireCrmActor(),
            parsed.data.object,
            parsed.data.id,
            parsed.data.note
        )
    }));
}

/** Make a task on a record. */
export async function createRecordTaskAction(
    input: unknown
): Promise<Outcome<{ task: LinkedTask }>> {
    const parsed = record.extend({ task: newTaskSchema }).safeParse(input);
    if (!parsed.success) return invalid();
    return outcome(async () => ({
        task: await activities.createRecordTask(
            await requireCrmActor(),
            parsed.data.object,
            parsed.data.id,
            parsed.data.task
        )
    }));
}

/** Link a file already in Drive to a record. */
export async function attachRecordFileAction(
    input: unknown
): Promise<Outcome<{ file: LinkedFile }>> {
    const parsed = record.extend({ file: driveFileSchema }).safeParse(input);
    if (!parsed.success) return invalid();
    return outcome(async () => ({
        file: await activities.attachRecordFile(
            await requireCrmActor(),
            parsed.data.object,
            parsed.data.id,
            parsed.data.file
        )
    }));
}

/** Tick a record's task off, or back. */
export async function setRecordTaskDoneAction(input: unknown): Promise<Outcome<{ done: boolean }>> {
    const parsed = record.extend({ taskId: z.string().uuid(), done: z.boolean() }).safeParse(input);
    if (!parsed.success) return invalid();
    const { object, id, taskId, done } = parsed.data;
    return outcome(async () => {
        await activities.setRecordTaskDone(await requireCrmActor(), object, id, taskId, done);
        return { done };
    });
}

/** Take a note, task or file off a record; the thing itself stays where it is. */
export async function unlinkAction(input: unknown): Promise<Outcome<{ removed: boolean }>> {
    const parsed = record
        .extend({ kind: z.enum(LINK_KINDS), targetId: z.string().uuid() })
        .safeParse(input);
    if (!parsed.success) return invalid();
    const { object, id, kind, targetId } = parsed.data;
    return outcome(async () => ({
        removed: await links.removeLink(await requireCrmActor(), object, id, kind, targetId)
    }));
}
