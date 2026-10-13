/**
 * Notes and tasks on a record. Both are Polaris's own Notes and Tasks, reached
 * through the host: a note or task made here is an ordinary one there, with its
 * access rules, history and live boards, and the record only keeps a link to it.
 *
 * Server-only.
 */

import { crmT } from "./i18n";
import { CrmRefusal } from "./errors";
import { prisma } from "@polaris/db";
import { host } from "@polaris/app-host";
import type { CrmObject } from "../model/objects";
import { table } from "./columns";
import { recordWhere, requireCan, type CrmActor } from "./access";
import { addLink, isLinked, linkedIds, requireLiveRecord } from "./links";
import {
    dueAt,
    type LinkedFile,
    type LinkedNote,
    type LinkedTask,
    type EventWith,
    type MailWith,
    type RecordActivities
} from "../model/links";

/** How many conversations and events a record shows. */
const ACTIVITY_LIMIT = 20;
/** How many of a company's people its mail and events are looked up for. */
const PEOPLE_LIMIT = 50;

/**
 * The addresses a record's mail and events are found by: a person's own, and
 * for a company or an opportunity, those of its people (and the opportunity's
 * point of contact). Only people the reader may read, and nothing when their
 * role hides people's email, since the conversations would name it.
 */
async function recordAddresses(
    actor: CrmActor,
    object: CrmObject,
    recordId: string
): Promise<string[]> {
    if (actor.rules?.people.hidden.includes("email")) return [];
    const people = recordWhere(actor, "people");
    let match: Record<string, unknown>;
    if (object === "people") {
        match = { id: recordId };
    } else if (object === "companies") {
        match = { companyId: recordId };
    } else {
        const deal = await prisma.crmOpportunity.findFirst({
            where: { id: recordId, ...recordWhere(actor, "opportunities") },
            select: { companyId: true, pointOfContactId: true }
        });
        if (!deal) return [];
        const or = [
            ...(deal.pointOfContactId ? [{ id: deal.pointOfContactId }] : []),
            ...(deal.companyId ? [{ companyId: deal.companyId }] : [])
        ];
        if (or.length === 0) return [];
        match = { OR: or };
    }
    const rows = await prisma.crmPerson.findMany({
        where: { AND: [people, match, { deletedAt: null, NOT: { email: "" } }] },
        select: { email: true },
        orderBy: { updatedAt: "desc" },
        take: PEOPLE_LIMIT
    });
    return rows.map((row) => row.email);
}

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
    const reached = await table(object).count({
        where: { id: recordId, ...recordWhere(actor, object) }
    });
    if (reached === 0) throw new CrmRefusal((await crmT())("errors.notFound"));
    const editing = actor.can[object].edit;
    const [noteIds, taskIds, fileIds, reach, shelves, lists, found] = await Promise.all([
        linkedIds(actor, object, recordId, "note"),
        linkedIds(actor, object, recordId, "task"),
        linkedIds(actor, object, recordId, "file"),
        host.crmHost.crmReach(who(actor)),
        editing ? host.crmHost.crmNoteShelves(who(actor)) : Promise.resolve(null),
        editing ? host.crmHost.taskListsFor(who(actor)) : Promise.resolve(null),
        recordAddresses(actor, object, recordId)
    ]);
    const [notes, tasks, files, mail, events] = await Promise.all([
        reach.notes ? host.crmHost.crmNotesByIds(who(actor), noteIds) : Promise.resolve(null),
        reach.tasks ? host.crmHost.tasksByIds(who(actor), taskIds) : Promise.resolve(null),
        host.crmHost.crmDriveFiles(who(actor), fileIds),
        host.crmHost.crmMailWith(who(actor), found, ACTIVITY_LIMIT) as Promise<MailWith[] | null>,
        host.crmHost.crmEventsWith(who(actor), found, ACTIVITY_LIMIT) as Promise<
            EventWith[] | null
        >
    ]);
    return {
        notes: notes ? notes.map((note: LinkedNote) => ({ ...note })) : null,
        noteShelves: editing && reach.notes ? (shelves ?? []) : [],
        tasks: tasks ? tasks.map(toTask) : null,
        taskLists: (lists ?? []).map((list: { id: string; name: string; spaceName: string }) => ({
            id: list.id,
            name: list.name,
            spaceName: list.spaceName
        })),
        files: files.map((file: LinkedFile) => ({ id: file.id, name: file.name, href: file.href })),
        mail: mail ? mail.map((one) => ({ ...one, participants: [...one.participants] })) : null,
        events: events ? events.map((one) => ({ ...one })) : null
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
