/**
 * Notes and tasks on a record. Both are Polaris's own Notes and Tasks, reached
 * through the host: a note or task made here is an ordinary one there, with its
 * access rules, history and live boards, and the record only keeps a link to it.
 *
 * Server-only.
 */

import { crmT } from "./i18n";
import { CrmRefusal } from "./errors";
import { host } from "@polaris/app-host";
import type { CrmObject } from "../model/objects";
import { requireCan, type CrmActor } from "./access";
import { addLink, isLinked, linkedIds, requireLiveRecord } from "./links";
import {
    dueAt,
    type LinkedFile,
    type LinkedNote,
    type LinkedTask,
    type RecordActivities
} from "../model/links";

const who = (actor: CrmActor) => ({ id: actor.user.id, isAdmin: actor.user.isAdmin });

function toTask(task: {
    id: string;
    name: string;
    reference: string;
    due: string | null;
    done: boolean;
    listName: string;
}): LinkedTask {
    return {
        id: task.id,
        name: task.name,
        reference: task.reference,
        due: task.due,
        done: task.done,
        listName: task.listName
    };
}

/** The notes and tasks on a record the reader may open, and where they may add more. */
export async function openActivities(
    actor: CrmActor,
    object: CrmObject,
    recordId: string
): Promise<RecordActivities> {
    await requireCan(actor, object, "read");
    const editing = actor.can[object].edit;
    const [noteIds, taskIds, fileIds, shelves, lists] = await Promise.all([
        linkedIds(actor, object, recordId, "note"),
        linkedIds(actor, object, recordId, "task"),
        linkedIds(actor, object, recordId, "file"),
        host.crmHost.crmNoteShelves(who(actor)),
        editing ? host.crmHost.taskListsFor(who(actor)) : Promise.resolve(null)
    ]);
    const [notes, tasks, files] = await Promise.all([
        shelves ? host.crmHost.crmNotesByIds(who(actor), noteIds) : Promise.resolve(null),
        host.crmHost.tasksByIds(who(actor), taskIds),
        host.crmHost.crmDriveFiles(who(actor), fileIds)
    ]);
    return {
        notes: notes ? notes.map((note: LinkedNote) => ({ ...note })) : null,
        noteShelves: editing ? (shelves ?? []) : [],
        tasks: tasks.map(toTask),
        taskLists: (lists ?? []).map((list: { id: string; name: string; spaceName: string }) => ({
            id: list.id,
            name: list.name,
            spaceName: list.spaceName
        })),
        files: files.map((file: LinkedFile) => ({ id: file.id, name: file.name, href: file.href }))
    };
}

/** Link a file already in Drive to a record. Nothing is copied: the record
 *  points at the file where it is, for whoever may open it there. */
export async function attachRecordFile(
    actor: CrmActor,
    object: CrmObject,
    recordId: string,
    input: { connectionId: string; path: string }
): Promise<LinkedFile> {
    await requireCan(actor, object, "edit");
    await requireLiveRecord(actor, object, recordId);
    const t = await crmT();
    const ref = await host.crmHost.crmDriveFileRef(who(actor), input.connectionId, input.path);
    if ("refused" in ref) throw new CrmRefusal(t("activities.fileRefused"));
    await addLink(actor, object, recordId, "file", ref.id);
    const [file] = await host.crmHost.crmDriveFiles(who(actor), [ref.id]);
    if (!file) throw new CrmRefusal(t("errors.generic"));
    return { id: file.id, name: file.name, href: file.href };
}

/** Write a note in Notes and link it to the record. */
export async function createRecordNote(
    actor: CrmActor,
    object: CrmObject,
    recordId: string,
    input: { title: string; body: string; spaceId: string | null }
): Promise<LinkedNote> {
    await requireCan(actor, object, "edit");
    await requireLiveRecord(actor, object, recordId);
    const t = await crmT();
    const made = await host.crmHost.crmCreateNote(who(actor), input);
    if ("refused" in made) throw new CrmRefusal(made.refused || t("activities.notesOff"));
    await addLink(actor, object, recordId, "note", made.id);
    const [note] = await host.crmHost.crmNotesByIds(who(actor), [made.id]);
    if (!note) throw new CrmRefusal(t("errors.generic"));
    return { ...note };
}

/** Make a task in Tasks, assigned to whoever made it, and link it to the record. */
export async function createRecordTask(
    actor: CrmActor,
    object: CrmObject,
    recordId: string,
    input: { name: string; listId: string; due: string | null }
): Promise<LinkedTask> {
    await requireCan(actor, object, "edit");
    await requireLiveRecord(actor, object, recordId);
    const t = await crmT();
    const made = await host.crmHost.createTask(who(actor), {
        listId: input.listId,
        name: input.name,
        due: dueAt(input.due)
    });
    if ("refused" in made) throw new CrmRefusal(made.refused || t("activities.tasksOff"));
    await addLink(actor, object, recordId, "task", made.id);
    const [task] = await host.crmHost.tasksByIds(who(actor), [made.id]);
    if (!task) throw new CrmRefusal(t("errors.generic"));
    return toTask(task);
}

/** Tick a task on a record off, or back - only one the record links to. */
export async function setRecordTaskDone(
    actor: CrmActor,
    object: CrmObject,
    recordId: string,
    taskId: string,
    done: boolean
): Promise<void> {
    const t = await crmT();
    if (!(await isLinked(actor, object, recordId, "task", taskId))) {
        throw new CrmRefusal(t("errors.notFound"));
    }
    const result = await host.crmHost.setTaskDone(who(actor), taskId, done);
    if (result.refused) throw new CrmRefusal(result.refused);
}
