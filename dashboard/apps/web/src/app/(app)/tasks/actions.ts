"use server";

/**
 * Every write the Tasks app makes.
 *
 * Each action does the same three things in the same order: check the instance
 * permission, check the space role, then validate the payload against the shared
 * schema before anything reaches a service. The client's copy of that schema is
 * what makes the form show errors as you type; this one is what makes them true.
 *
 * Actions return `{ error }` rather than throwing, because a rejected server
 * action inside a transition escalates to the nearest error boundary and would
 * replace the whole screen over one refused write (see run-action).
 */

import * as core from "@polaris/core";
import { revalidatePath } from "next/cache";
import * as access from "@/lib/tasks/access";
import * as docs from "@/lib/tasks/doc-service";
import * as time from "@/lib/tasks/time-service";
import { recordAudit } from "@/lib/audit-service";
import { requirePermission } from "@/lib/session";
import * as tasks from "@/lib/tasks/task-service";
import * as views from "@/lib/tasks/view-service";
import * as forms from "@/lib/tasks/form-service";
import * as spaces from "@/lib/tasks/space-service";
import * as shares from "@/lib/tasks/share-service";
import * as commits from "@/lib/tasks/commit-service";
import * as files from "@/lib/tasks/attachment-service";
import * as planning from "@/lib/tasks/planning-service";
import * as details from "@/lib/tasks/task-detail-service";
import * as automations from "@/lib/tasks/automation-service";

const TASKS_PATH = "/tasks";

/** The caller, once the instance permission has been established. */
async function actor(permission: "tasks.read" | "tasks.manage" = "tasks.manage"): Promise<access.TaskActor> {
    const user = await requirePermission(permission);
    return { id: user.id, isAdmin: user.isAdmin };
}

/** Turn whatever went wrong into one line the user can act on. Service errors
 *  are written for people and pass through; anything else is a bug and is
 *  logged rather than shown. */
function failure(caught: unknown, fallback: string): { error: string } {
    if (caught instanceof access.TaskAccessError) return { error: caught.message };
    if (caught instanceof Error && caught.message && !caught.message.includes("\n")) return { error: caught.message };
    console.error(caught);
    return { error: fallback };
}

/** Refresh the screens a change can be visible on. The app is small enough that
 *  refreshing its subtree beats trying to guess which page the user is on. */
function refresh(): void {
    revalidatePath(TASKS_PATH, "layout");
}

// ---------------------------------------------------------------------------
// Spaces, folders, lists
// ---------------------------------------------------------------------------

export async function createSpaceAction(input: unknown): Promise<{ id?: string; error?: string }> {
    const caller = await actor();
    const parsed = core.spaceSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the details and try again" };
    try {
        const created = await spaces.createSpace(caller.id, parsed.data);
        await recordAudit({ actorId: caller.id, action: "tasks.space.create", targetType: "space", targetId: created.id });
        refresh();
        return { id: created.id };
    } catch (caught) {
        return failure(caught, "Could not create the space");
    }
}

export async function updateSpaceAction(spaceId: string, input: unknown): Promise<{ error?: string }> {
    const caller = await actor();
    const parsed = core.spaceSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the details and try again" };
    try {
        await access.requireSpace(caller, spaceId, "admin");
        await spaces.updateSpace(spaceId, parsed.data);
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "Could not save the space");
    }
}

export async function deleteSpaceAction(spaceId: string): Promise<{ error?: string }> {
    const caller = await actor();
    try {
        const role = await access.requireSpace(caller, spaceId, "admin");
        if (role !== "owner") return { error: "Only the space owner can delete it" };
        await spaces.deleteSpace(spaceId);
        await recordAudit({ actorId: caller.id, action: "tasks.space.delete", targetType: "space", targetId: spaceId });
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "Could not delete the space");
    }
}

export async function addSpaceMemberAction(
    spaceId: string,
    identifier: string,
    role: core.SpaceRole
): Promise<{ error?: string }> {
    const caller = await actor();
    try {
        await access.requireSpace(caller, spaceId, "admin");
        await spaces.addSpaceMember(spaceId, identifier, role);
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "Could not add that person");
    }
}

export async function setSpaceMemberRoleAction(
    spaceId: string,
    userId: string,
    role: core.SpaceRole
): Promise<{ error?: string }> {
    const caller = await actor();
    try {
        await access.requireSpace(caller, spaceId, "admin");
        await spaces.setSpaceMemberRole(spaceId, userId, role);
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "Could not change that role");
    }
}

export async function removeSpaceMemberAction(spaceId: string, userId: string): Promise<{ error?: string }> {
    const caller = await actor();
    try {
        await access.requireSpace(caller, spaceId, "admin");
        await spaces.removeSpaceMember(spaceId, userId);
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "Could not remove that person");
    }
}

export async function createFolderAction(input: unknown): Promise<{ id?: string; error?: string }> {
    const caller = await actor();
    const parsed = core.folderSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Enter a name" };
    try {
        // A subfolder is authorized against the folder it goes into, so somebody
        // invited to one client can organise inside it without holding the space.
        if (parsed.data.parentId) await access.requireFolder(caller, parsed.data.parentId, "member");
        else await access.requireSpace(caller, parsed.data.spaceId, "member");
        const id = await spaces.createFolder(parsed.data);
        refresh();
        return { id };
    } catch (caught) {
        return failure(caught, "Could not create the folder");
    }
}

export async function renameFolderAction(folderId: string, name: string): Promise<{ error?: string }> {
    const caller = await actor();
    const parsed = core.containerName.safeParse(name);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Enter a name" };
    try {
        await access.requireFolder(caller, folderId, "member");
        await spaces.renameFolder(folderId, parsed.data);
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "Could not rename the folder");
    }
}

export async function deleteFolderAction(folderId: string): Promise<{ error?: string }> {
    const caller = await actor();
    try {
        await access.requireFolder(caller, folderId, "admin");
        await spaces.deleteFolder(folderId);
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "Could not delete the folder");
    }
}

/** Reparent or reposition a folder after a drag in the sidebar. */
export async function moveFolderAction(folderId: string, move: unknown): Promise<{ error?: string }> {
    const caller = await actor();
    const parsed = core.containerMoveSchema.safeParse(move);
    if (!parsed.success) return { error: "Could not work out where that was dropped" };
    try {
        const { spaceId } = await access.requireFolder(caller, folderId, "member");
        // Both ends are checked: dragging out of a branch you may edit into one
        // you may not is still a write to the destination.
        if (parsed.data.parentId) await access.requireFolder(caller, parsed.data.parentId, "member");
        else await access.requireSpace(caller, spaceId, "member");
        await spaces.moveFolder(spaceId, folderId, parsed.data);
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "Could not move the folder");
    }
}

/** Move a list into a folder, out to the space root, or up and down its
 *  siblings, after a drag in the sidebar. */
export async function moveListAction(listId: string, move: unknown): Promise<{ error?: string }> {
    const caller = await actor();
    const parsed = core.containerMoveSchema.safeParse(move);
    if (!parsed.success) return { error: "Could not work out where that was dropped" };
    try {
        const { spaceId } = await access.requireList(caller, listId, "member");
        if (parsed.data.parentId) await access.requireFolder(caller, parsed.data.parentId, "member");
        else await access.requireSpace(caller, spaceId, "member");
        await spaces.moveList(spaceId, listId, parsed.data);
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "Could not move the list");
    }
}

// ---------------------------------------------------------------------------
// Folder members
// ---------------------------------------------------------------------------

export async function listFolderMembersAction(folderId: string): Promise<{
    folder?: spaces.FolderDetail;
    members?: spaces.FolderMemberView[];
    error?: string;
}> {
    const caller = await actor("tasks.read");
    try {
        await access.requireFolder(caller, folderId, "guest");
        const [folder, members] = await Promise.all([
            spaces.getFolder(folderId),
            spaces.listFolderMembers(folderId)
        ]);
        return folder ? { folder, members } : { error: "That folder no longer exists" };
    } catch (caught) {
        return failure(caught, "Could not read who has access");
    }
}

export async function addFolderMemberAction(
    folderId: string,
    identifier: string,
    role: core.SpaceRole
): Promise<{ error?: string }> {
    const caller = await actor();
    try {
        await access.requireFolder(caller, folderId, "admin");
        await spaces.addFolderMember(folderId, identifier, role);
        await recordAudit({
            actorId: caller.id,
            action: "tasks.folder.invite",
            targetType: "folder",
            targetId: folderId
        });
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "Could not add that person");
    }
}

export async function setFolderMemberRoleAction(
    folderId: string,
    userId: string,
    role: core.SpaceRole
): Promise<{ error?: string }> {
    const caller = await actor();
    try {
        await access.requireFolder(caller, folderId, "admin");
        await spaces.setFolderMemberRole(folderId, userId, role);
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "Could not change that role");
    }
}

export async function removeFolderMemberAction(folderId: string, userId: string): Promise<{ error?: string }> {
    const caller = await actor();
    try {
        await access.requireFolder(caller, folderId, "admin");
        await spaces.removeFolderMember(folderId, userId);
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "Could not remove that person");
    }
}

/** What the sidebar needs to open a create dialog for a space or one folder in
 *  it: the vocabulary of that space and the lists a task could go into. Fetched
 *  when the dialog opens rather than sent with every page, because most visits
 *  never create anything. */
export async function createContextAction(
    spaceId: string,
    folderId: string | null
): Promise<{ context?: spaces.CreateContext; error?: string }> {
    const caller = await actor();
    try {
        if (folderId) await access.requireFolder(caller, folderId, "member");
        else await access.requireSpace(caller, spaceId, "member");
        const [statuses, tags, people, lists] = await Promise.all([
            spaces.listStatuses(spaceId),
            spaces.listTags(spaceId),
            spaces.spacePeople(spaceId),
            spaces.branchLists(spaceId, folderId)
        ]);
        return { context: { spaceId, statuses, tags, people, lists } };
    } catch (caught) {
        return failure(caught, "Could not open that");
    }
}

export async function createListAction(input: unknown): Promise<{ id?: string; error?: string }> {
    const caller = await actor();
    const parsed = core.listSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the details and try again" };
    try {
        // Authorized against the folder it goes into when there is one, so
        // somebody invited to a single project can add a list inside it without
        // being handed the space around it.
        if (parsed.data.folderId) await access.requireFolder(caller, parsed.data.folderId, "member");
        else await access.requireSpace(caller, parsed.data.spaceId, "member");
        const id = await spaces.createList(parsed.data);
        refresh();
        return { id };
    } catch (caught) {
        return failure(caught, "Could not create the list");
    }
}

export async function updateListAction(listId: string, input: unknown): Promise<{ error?: string }> {
    const caller = await actor();
    try {
        const { spaceId } = await access.requireList(caller, listId, "member");
        const parsed = core.listSchema.safeParse({ ...(input as object), spaceId });
        if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the details and try again" };
        await spaces.updateList(listId, parsed.data);
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "Could not save the list");
    }
}

/** Rename in place from the sidebar. Separate from updateListAction because that
 *  one takes the whole list and would blank the fields a rename never sees. */
export async function renameListAction(listId: string, name: string): Promise<{ error?: string }> {
    const caller = await actor();
    const parsed = core.containerName.safeParse(name);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Enter a name" };
    try {
        await access.requireList(caller, listId, "member");
        await spaces.renameList(listId, parsed.data);
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "Could not rename the list");
    }
}

export async function renameSpaceAction(spaceId: string, name: string): Promise<{ error?: string }> {
    const caller = await actor();
    const parsed = core.containerName.safeParse(name);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Enter a name" };
    try {
        await access.requireSpace(caller, spaceId, "admin");
        await spaces.renameSpace(spaceId, parsed.data);
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "Could not rename the space");
    }
}

export async function deleteListAction(listId: string): Promise<{ error?: string }> {
    const caller = await actor();
    try {
        await access.requireList(caller, listId, "admin");
        await spaces.deleteList(listId);
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "Could not delete the list");
    }
}

// ---------------------------------------------------------------------------
// Statuses, tags, custom fields
// ---------------------------------------------------------------------------

export async function createStatusAction(
    spaceId: string,
    input: { name: string; type: core.TaskStatusType; color: string }
): Promise<{ id?: string; error?: string }> {
    const caller = await actor();
    const parsed = core.statusSchema.safeParse({ spaceId, ...input });
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the status and try again" };
    try {
        await access.requireSpace(caller, spaceId, "admin");
        const id = await spaces.createStatus(spaceId, parsed.data.name, parsed.data.type, parsed.data.color);
        refresh();
        return { id };
    } catch (caught) {
        return failure(caught, "Could not add the status");
    }
}

export async function updateStatusAction(
    spaceId: string,
    statusId: string,
    input: { name: string; type: core.TaskStatusType; color: string }
): Promise<{ error?: string }> {
    const caller = await actor();
    const parsed = core.statusSchema.safeParse({ spaceId, ...input });
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the status and try again" };
    try {
        await access.requireSpace(caller, spaceId, "admin");
        await spaces.updateStatus(statusId, parsed.data);
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "Could not save the status");
    }
}

export async function deleteStatusAction(
    spaceId: string,
    statusId: string,
    replacementId: string
): Promise<{ error?: string }> {
    const caller = await actor();
    try {
        await access.requireSpace(caller, spaceId, "admin");
        await spaces.deleteStatus(spaceId, statusId, replacementId);
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "Could not remove the status");
    }
}

export async function reorderStatusesAction(spaceId: string, orderedIds: string[]): Promise<{ error?: string }> {
    const caller = await actor();
    try {
        await access.requireSpace(caller, spaceId, "admin");
        await spaces.reorderStatuses(spaceId, orderedIds);
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "Could not reorder the statuses");
    }
}

export async function createTagAction(spaceId: string, name: string, color: string): Promise<{ id?: string; error?: string }> {
    const caller = await actor();
    const parsed = core.tagSchema.safeParse({ spaceId, name, color });
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the tag and try again" };
    try {
        await access.requireSpace(caller, spaceId, "member");
        const id = await spaces.createTag(spaceId, parsed.data.name, parsed.data.color);
        refresh();
        return { id };
    } catch (caught) {
        return failure(caught, "Could not add the tag");
    }
}

export async function updateTagAction(
    spaceId: string,
    tagId: string,
    name: string,
    color: string
): Promise<{ error?: string }> {
    const caller = await actor();
    const parsed = core.tagSchema.safeParse({ spaceId, name, color });
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the tag and try again" };
    try {
        await access.requireSpace(caller, spaceId, "member");
        await spaces.updateTag(tagId, parsed.data.name, parsed.data.color);
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "Could not save the tag");
    }
}

export async function deleteTagAction(spaceId: string, tagId: string): Promise<{ error?: string }> {
    const caller = await actor();
    try {
        await access.requireSpace(caller, spaceId, "admin");
        await spaces.deleteTag(tagId);
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "Could not remove the tag");
    }
}

export async function createCustomFieldAction(input: unknown): Promise<{ error?: string }> {
    const caller = await actor();
    const parsed = core.customFieldSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the field and try again" };
    try {
        await access.requireSpace(caller, parsed.data.spaceId, "admin");
        await spaces.createCustomField(parsed.data);
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "Could not add the field");
    }
}

export async function updateCustomFieldAction(
    spaceId: string,
    fieldId: string,
    input: unknown
): Promise<{ error?: string }> {
    const caller = await actor();
    const parsed = core.customFieldSchema.safeParse({ ...(input as object), spaceId });
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the field and try again" };
    try {
        await access.requireSpace(caller, spaceId, "admin");
        await spaces.updateCustomField(fieldId, parsed.data);
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "Could not save the field");
    }
}

export async function deleteCustomFieldAction(spaceId: string, fieldId: string): Promise<{ error?: string }> {
    const caller = await actor();
    try {
        await access.requireSpace(caller, spaceId, "admin");
        await spaces.deleteCustomField(fieldId);
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "Could not remove the field");
    }
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export async function createTaskAction(input: unknown): Promise<{ id?: string; reference?: string; error?: string }> {
    const caller = await actor();
    const parsed = core.taskCreateSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the task and try again" };
    try {
        const { spaceId } = await access.requireList(caller, parsed.data.listId, "member");
        const created = await tasks.createTask(caller.id, spaceId, parsed.data);
        refresh();
        return created;
    } catch (caught) {
        return failure(caught, "Could not create the task");
    }
}

export async function updateTaskAction(input: unknown): Promise<{ error?: string }> {
    const caller = await actor();
    const parsed = core.taskUpdateSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the task and try again" };
    try {
        await access.requireTask(caller, parsed.data.taskId, "member");
        await tasks.updateTask(caller.id, parsed.data);
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "Could not save the task");
    }
}

export async function moveTaskAction(input: unknown): Promise<{ error?: string }> {
    const caller = await actor();
    const parsed = core.taskMoveSchema.safeParse(input);
    if (!parsed.success) return { error: "Could not work out where that was dropped" };
    try {
        await access.requireTask(caller, parsed.data.taskId, "member");
        await tasks.moveTask(caller.id, parsed.data);
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "Could not move the task");
    }
}

export async function bulkUpdateAction(input: unknown): Promise<{ count?: number; error?: string }> {
    const caller = await actor();
    const parsed = core.taskBulkSchema.safeParse(input);
    if (!parsed.success) return { error: "Check the selection and try again" };
    try {
        const scope = await access.visibleScope(caller);
        const count = await tasks.bulkUpdate(caller.id, { spaceIds: scope.spaceIds, listIds: scope.listIds }, parsed.data);
        refresh();
        return { count };
    } catch (caught) {
        return failure(caught, "Could not apply that change");
    }
}

export async function deleteTaskAction(taskId: string): Promise<{ error?: string }> {
    const caller = await actor();
    try {
        await access.requireTask(caller, taskId, "member");
        await tasks.deleteTask(taskId);
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "Could not delete the task");
    }
}

export async function duplicateTaskAction(taskId: string): Promise<{ id?: string; error?: string }> {
    const caller = await actor();
    try {
        await access.requireTask(caller, taskId, "member");
        const id = await tasks.duplicateTask(caller.id, taskId);
        refresh();
        return { id: id ?? undefined };
    } catch (caught) {
        return failure(caught, "Could not duplicate the task");
    }
}

/** Everything the task panel needs, so opening a card is one round trip. */
export async function getTaskDetailAction(taskId: string): Promise<{
    detail?: tasks.TaskDetail;
    error?: string;
}> {
    const caller = await actor("tasks.read");
    try {
        await access.requireTask(caller, taskId, "guest");
        const detail = await tasks.getTaskDetail(taskId);
        return detail ? { detail } : { error: "That task no longer exists" };
    } catch (caught) {
        return failure(caught, "Could not open the task");
    }
}

export async function setWatchingAction(taskId: string, watching: boolean): Promise<{ error?: string }> {
    const caller = await actor("tasks.read");
    try {
        await access.requireTask(caller, taskId, "guest");
        await details.setWatching(taskId, caller.id, watching);
        return {};
    } catch (caught) {
        return failure(caught, "Could not change that");
    }
}

// ---------------------------------------------------------------------------
// Comments, checklists, dependencies, fields
// ---------------------------------------------------------------------------

export async function addCommentAction(input: unknown): Promise<{ error?: string }> {
    const caller = await actor("tasks.read");
    const parsed = core.commentSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Write something first" };
    try {
        await access.requireTask(caller, parsed.data.taskId, "guest");
        await details.addComment(caller.id, parsed.data);
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "Could not post the comment");
    }
}

export async function editCommentAction(taskId: string, commentId: string, body: string): Promise<{ error?: string }> {
    const caller = await actor("tasks.read");
    const parsed = core.commentSchema.shape.body.safeParse(body);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Write something first" };
    try {
        await access.requireTask(caller, taskId, "guest");
        await details.editComment(caller.id, commentId, parsed.data);
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "Could not save the comment");
    }
}

export async function deleteCommentAction(taskId: string, commentId: string): Promise<{ error?: string }> {
    const caller = await actor("tasks.read");
    try {
        const { role } = await access.requireTask(caller, taskId, "guest");
        await details.deleteComment(caller.id, commentId, role === "owner" || role === "admin");
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "Could not delete the comment");
    }
}

export async function resolveCommentAction(
    taskId: string,
    commentId: string,
    resolved: boolean
): Promise<{ error?: string }> {
    const caller = await actor("tasks.read");
    try {
        await access.requireTask(caller, taskId, "guest");
        await details.setCommentResolved(caller.id, commentId, resolved);
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "Could not update the comment");
    }
}

export async function createChecklistAction(taskId: string, name: string): Promise<{ error?: string }> {
    const caller = await actor();
    const parsed = core.checklistSchema.safeParse({ taskId, name });
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Enter a name" };
    try {
        await access.requireTask(caller, taskId, "member");
        await details.createChecklist(taskId, parsed.data.name);
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "Could not add the checklist");
    }
}

/** Reorder the checklists on a task after a drag. */
export async function moveChecklistAction(
    taskId: string,
    checklistId: string,
    move: unknown
): Promise<{ error?: string }> {
    const caller = await actor();
    const parsed = core.checklistMoveSchema.safeParse(move);
    if (!parsed.success) return { error: "Could not work out where that was dropped" };
    try {
        await access.requireTask(caller, taskId, "member");
        await details.moveChecklist(taskId, checklistId, parsed.data);
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "Could not move the checklist");
    }
}

/** Reorder a step, or move it into another checklist on the same task. */
export async function moveChecklistItemAction(
    taskId: string,
    itemId: string,
    move: unknown
): Promise<{ error?: string }> {
    const caller = await actor();
    const parsed = core.checklistItemMoveSchema.safeParse(move);
    if (!parsed.success) return { error: "Could not work out where that was dropped" };
    try {
        await access.requireTask(caller, taskId, "member");
        await details.moveChecklistItem(taskId, itemId, parsed.data);
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "Could not move the step");
    }
}

export async function deleteChecklistAction(taskId: string, checklistId: string): Promise<{ error?: string }> {
    const caller = await actor();
    try {
        await access.requireTask(caller, taskId, "member");
        await details.deleteChecklist(checklistId);
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "Could not remove the checklist");
    }
}

export async function addChecklistItemAction(
    taskId: string,
    checklistId: string,
    name: string
): Promise<{ error?: string }> {
    const caller = await actor();
    const parsed = core.taskName.safeParse(name);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Enter a step" };
    try {
        await access.requireTask(caller, taskId, "member");
        await details.addChecklistItem(checklistId, parsed.data);
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "Could not add the step");
    }
}

/** Ticking a step is the one write a guest may make, because it is how somebody
 *  reports what they did rather than reshaping the work. */
export async function setChecklistItemDoneAction(
    taskId: string,
    itemId: string,
    done: boolean
): Promise<{ error?: string }> {
    const caller = await actor("tasks.read");
    try {
        await access.requireTask(caller, taskId, "guest");
        await details.setChecklistItemDone(itemId, done);
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "Could not update the step");
    }
}

export async function deleteChecklistItemAction(taskId: string, itemId: string): Promise<{ error?: string }> {
    const caller = await actor();
    try {
        await access.requireTask(caller, taskId, "member");
        await details.deleteChecklistItem(itemId);
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "Could not remove the step");
    }
}

/** Promote a checklist step to a task of its own in the same list. */
export async function promoteChecklistItemAction(taskId: string, itemId: string): Promise<{ id?: string; error?: string }> {
    const caller = await actor();
    try {
        const { listId, spaceId } = await access.requireTask(caller, taskId, "member");
        const id = await details.promoteChecklistItem(itemId, (name) =>
            tasks.createTask(caller.id, spaceId, {
                listId,
                name,
                description: "",
                parentId: taskId,
                statusId: null,
                priority: "none",
                assigneeIds: [],
                tagIds: [],
                startDate: null,
                dueDate: null,
                timed: false,
                timeEstimate: null,
                points: null,
                sprintId: null,
                milestone: false,
                recurrence: null
            })
        );
        refresh();
        return { id: id ?? undefined };
    } catch (caught) {
        return failure(caught, "Could not turn that step into a task");
    }
}

export async function addDependencyAction(input: unknown): Promise<{ error?: string }> {
    const caller = await actor();
    const parsed = core.dependencySchema.safeParse(input);
    if (!parsed.success) return { error: "Pick a task to link" };
    try {
        const { spaceId } = await access.requireTask(caller, parsed.data.taskId, "member");
        await details.addDependency(spaceId, parsed.data);
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "Could not link those tasks");
    }
}

export async function removeDependencyAction(taskId: string, dependencyId: string): Promise<{ error?: string }> {
    const caller = await actor();
    try {
        await access.requireTask(caller, taskId, "member");
        await details.removeDependency(dependencyId);
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "Could not remove the link");
    }
}

export async function setCustomValueAction(
    taskId: string,
    fieldId: string,
    value: string
): Promise<{ error?: string }> {
    const caller = await actor();
    try {
        const { spaceId } = await access.requireTask(caller, taskId, "member");
        await details.setCustomValue(spaceId, taskId, fieldId, value.slice(0, 5000));
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "Could not save that value");
    }
}

export async function addReminderAction(taskId: string, remindAt: string, note: string): Promise<{ error?: string }> {
    const caller = await actor("tasks.read");
    const parsed = core.reminderSchema.safeParse({ taskId, remindAt, note });
    if (!parsed.success) return { error: "Pick a date and time" };
    try {
        await access.requireTask(caller, taskId, "guest");
        await details.addReminder(caller.id, taskId, parsed.data.remindAt, parsed.data.note);
        return {};
    } catch (caught) {
        return failure(caught, "Could not set the reminder");
    }
}

// ---------------------------------------------------------------------------
// Sharing
// ---------------------------------------------------------------------------

/**
 * What the share dialog opens with. Everyone who can read the task gets the
 * private link; the public one is only described to somebody who could turn it
 * on, so a guest is never handed a token to pass along.
 */
export async function getTaskShareAction(taskId: string): Promise<{
    privateUrl?: string;
    share?: shares.TaskShareView | null;
    canShare?: boolean;
    error?: string;
}> {
    const caller = await actor("tasks.read");
    try {
        const { role } = await access.requireTask(caller, taskId, "guest");
        const canShare = role === "owner" || role === "admin" || role === "member";
        return {
            privateUrl: await shares.taskLink(taskId),
            share: canShare ? await shares.getTaskShare(taskId) : null,
            canShare
        };
    } catch (caught) {
        return failure(caught, "Could not read the sharing settings");
    }
}

export async function setTaskShareAction(input: unknown): Promise<{
    share?: shares.TaskShareView | null;
    error?: string;
}> {
    const caller = await actor();
    const parsed = core.taskShareSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the details and try again" };
    try {
        await access.requireTask(caller, parsed.data.taskId, "member");
        const share = await shares.setTaskShare(caller.id, parsed.data);
        await recordAudit({
            actorId: caller.id,
            action: parsed.data.enabled ? "tasks.share.enable" : "tasks.share.disable",
            targetType: "task",
            targetId: parsed.data.taskId
        });
        return { share };
    } catch (caught) {
        return failure(caught, "Could not change the public link");
    }
}

export async function sendTaskShareAction(input: unknown): Promise<{
    sent?: string[];
    failures?: { recipient: string; reason: string }[];
    error?: string;
}> {
    const user = await requirePermission("tasks.manage");
    const caller: access.TaskActor = { id: user.id, isAdmin: user.isAdmin };
    const parsed = core.taskShareEmailSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Choose who to send it to" };
    try {
        await access.requireTask(caller, parsed.data.taskId, "member");
        const delivery = await shares.sendTaskByEmail({ id: user.id, name: user.name }, parsed.data);
        return { sent: delivery.sent, failures: delivery.failures };
    } catch (caught) {
        return failure(caught, "Could not send the task");
    }
}

// ---------------------------------------------------------------------------
// Attachments and commits
// ---------------------------------------------------------------------------

/** Uploading goes through /api/tasks/attachments, which streams the body; this
 *  is only the other half - taking one off again. */
export async function deleteAttachmentAction(taskId: string, attachmentId: string): Promise<{ error?: string }> {
    const caller = await actor();
    try {
        await access.requireTask(caller, taskId, "member");
        const owner = await files.attachmentTaskId(attachmentId);
        // The id came from the client, so it is checked against the task the
        // caller was actually cleared for.
        if (owner !== taskId) return { error: "That file is not on this task" };
        await files.deleteAttachment(attachmentId);
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "Could not remove that file");
    }
}

export async function linkCommitAction(taskId: string, reference: string): Promise<{ error?: string }> {
    const caller = await actor();
    try {
        await access.requireTask(caller, taskId, "member");
        await commits.linkCommit(taskId, caller.id, reference.slice(0, 500));
        refresh();
        return {};
    } catch (caught) {
        if (caught instanceof commits.CommitLinkError) return { error: caught.message };
        return failure(caught, "Could not link that commit");
    }
}

export async function unlinkCommitAction(taskId: string, commitId: string): Promise<{ error?: string }> {
    const caller = await actor();
    try {
        await access.requireTask(caller, taskId, "member");
        await commits.unlinkCommit(taskId, commitId);
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "Could not unlink that commit");
    }
}

// ---------------------------------------------------------------------------
// Time tracking
// ---------------------------------------------------------------------------

export async function startTimerAction(taskId: string): Promise<{ error?: string }> {
    const caller = await actor("tasks.read");
    try {
        await access.requireTask(caller, taskId, "guest");
        await time.startTimer(caller.id, taskId);
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "Could not start the timer");
    }
}

export async function stopTimerAction(): Promise<{ seconds?: number; error?: string }> {
    const caller = await actor("tasks.read");
    try {
        const seconds = await time.stopTimer(caller.id);
        refresh();
        return { seconds };
    } catch (caught) {
        return failure(caught, "Could not stop the timer");
    }
}

export async function addTimeEntryAction(taskId: string, duration: string, note: string, billable: boolean): Promise<{ error?: string }> {
    const caller = await actor("tasks.read");
    const minutes = core.parseDurationMinutes(duration);
    if (minutes === null || minutes <= 0) return { error: "Enter a length like 1h 30m" };
    const parsed = core.timeEntrySchema.safeParse({ taskId, duration: minutes * 60, note, billable });
    if (!parsed.success) return { error: "Check the entry and try again" };
    try {
        await access.requireTask(caller, taskId, "guest");
        await time.addTimeEntry(caller.id, parsed.data);
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "Could not log that time");
    }
}

export async function deleteTimeEntryAction(taskId: string, entryId: string): Promise<{ error?: string }> {
    const caller = await actor("tasks.read");
    try {
        const { role } = await access.requireTask(caller, taskId, "guest");
        await time.deleteTimeEntry(caller.id, entryId, role === "owner" || role === "admin");
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "Could not remove that entry");
    }
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export async function createViewAction(input: unknown): Promise<{ id?: string; error?: string }> {
    const caller = await actor();
    const parsed = core.taskViewSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the view and try again" };
    try {
        if (parsed.data.listId) await access.requireList(caller, parsed.data.listId, "member");
        else if (parsed.data.spaceId) await access.requireSpace(caller, parsed.data.spaceId, "member");
        else return { error: "A view has to belong to a list or a space" };
        const id = await views.createView(caller.id, parsed.data);
        refresh();
        return { id };
    } catch (caught) {
        return failure(caught, "Could not save the view");
    }
}

export async function updateViewAction(viewId: string, input: unknown): Promise<{ error?: string }> {
    const caller = await actor();
    const parsed = core.taskViewSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the view and try again" };
    try {
        const existing = await views.getView(viewId);
        if (!existing) return { error: "That view no longer exists" };
        const role = existing.listId
            ? (await access.requireList(caller, existing.listId, "member")).role
            : await access.requireSpace(caller, existing.spaceId as string, "member");
        await views.updateView(caller.id, viewId, parsed.data, role === "owner" || role === "admin");
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "Could not save the view");
    }
}

export async function deleteViewAction(viewId: string): Promise<{ error?: string }> {
    const caller = await actor();
    try {
        const existing = await views.getView(viewId);
        if (!existing) return {};
        const role = existing.listId
            ? (await access.requireList(caller, existing.listId, "member")).role
            : await access.requireSpace(caller, existing.spaceId as string, "member");
        await views.deleteView(caller.id, viewId, role === "owner" || role === "admin");
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "Could not remove the view");
    }
}

// ---------------------------------------------------------------------------
// Sprints and goals
// ---------------------------------------------------------------------------

export async function createSprintAction(input: unknown): Promise<{ error?: string }> {
    const caller = await actor();
    const parsed = core.sprintSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the dates and try again" };
    try {
        // A sprint planning one folder is authorized against that folder, which
        // is what lets a project run its own sprints inside a shared space.
        if (parsed.data.folderId) await access.requireFolder(caller, parsed.data.folderId, "member");
        else await access.requireSpace(caller, parsed.data.spaceId, "member");
        await planning.createSprint(parsed.data);
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "Could not create the sprint");
    }
}

export async function updateSprintAction(spaceId: string, sprintId: string, input: unknown): Promise<{ error?: string }> {
    const caller = await actor();
    const parsed = core.sprintSchema.safeParse({ ...(input as object), spaceId });
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the dates and try again" };
    try {
        await access.requireSpace(caller, spaceId, "member");
        await planning.updateSprint(sprintId, parsed.data);
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "Could not save the sprint");
    }
}

export async function setSprintStatusAction(
    spaceId: string,
    sprintId: string,
    status: "planned" | "active" | "completed"
): Promise<{ error?: string }> {
    const caller = await actor();
    try {
        await access.requireSpace(caller, spaceId, "member");
        await planning.setSprintStatus(spaceId, sprintId, status);
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "Could not change the sprint");
    }
}

export async function deleteSprintAction(spaceId: string, sprintId: string): Promise<{ error?: string }> {
    const caller = await actor();
    try {
        await access.requireSpace(caller, spaceId, "admin");
        await planning.deleteSprint(sprintId);
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "Could not delete the sprint");
    }
}

export async function setTaskSprintAction(taskId: string, sprintId: string | null): Promise<{ error?: string }> {
    const caller = await actor();
    try {
        await access.requireTask(caller, taskId, "member");
        await planning.setTaskSprint(taskId, sprintId);
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "Could not move that task");
    }
}

export async function createGoalAction(input: unknown): Promise<{ id?: string; error?: string }> {
    const caller = await actor();
    const parsed = core.goalSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the goal and try again" };
    try {
        if (parsed.data.spaceId) await access.requireSpace(caller, parsed.data.spaceId, "member");
        const id = await planning.createGoal(caller.id, parsed.data);
        refresh();
        return { id };
    } catch (caught) {
        return failure(caught, "Could not create the goal");
    }
}

export async function updateGoalAction(goalId: string, input: unknown): Promise<{ error?: string }> {
    const caller = await actor();
    const parsed = core.goalSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the goal and try again" };
    try {
        if (parsed.data.spaceId) await access.requireSpace(caller, parsed.data.spaceId, "member");
        await planning.updateGoal(goalId, parsed.data);
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "Could not save the goal");
    }
}

export async function setGoalCompletedAction(goalId: string, completed: boolean): Promise<{ error?: string }> {
    await actor();
    try {
        await planning.setGoalCompleted(goalId, completed);
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "Could not update the goal");
    }
}

export async function deleteGoalAction(goalId: string): Promise<{ error?: string }> {
    await actor();
    try {
        await planning.deleteGoal(goalId);
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "Could not delete the goal");
    }
}

export async function addGoalTargetAction(goalId: string, input: unknown): Promise<{ error?: string }> {
    await actor();
    const parsed = core.goalTargetSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the target and try again" };
    try {
        await planning.addGoalTarget(goalId, parsed.data);
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "Could not add the target");
    }
}

export async function setGoalTargetValueAction(targetId: string, value: number): Promise<{ error?: string }> {
    await actor();
    if (!Number.isFinite(value)) return { error: "Enter a number" };
    try {
        await planning.setGoalTargetValue(targetId, value);
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "Could not update the target");
    }
}

export async function deleteGoalTargetAction(targetId: string): Promise<{ error?: string }> {
    await actor();
    try {
        await planning.deleteGoalTarget(targetId);
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "Could not remove the target");
    }
}

// ---------------------------------------------------------------------------
// Automations
// ---------------------------------------------------------------------------

export async function createAutomationAction(input: unknown): Promise<{ error?: string }> {
    const caller = await actor();
    const parsed = core.automationSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the rule and try again" };
    if (!parsed.data.spaceId) return { error: "A rule has to belong to a space" };
    try {
        await access.requireSpace(caller, parsed.data.spaceId, "admin");
        await automations.createAutomation(parsed.data.spaceId, caller.id, parsed.data);
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "Could not save the rule");
    }
}

export async function updateAutomationAction(
    spaceId: string,
    automationId: string,
    input: unknown
): Promise<{ error?: string }> {
    const caller = await actor();
    const parsed = core.automationSchema.safeParse({ ...(input as object), spaceId });
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the rule and try again" };
    try {
        await access.requireSpace(caller, spaceId, "admin");
        await automations.updateAutomation(automationId, parsed.data);
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "Could not save the rule");
    }
}

export async function setAutomationEnabledAction(
    spaceId: string,
    automationId: string,
    enabled: boolean
): Promise<{ error?: string }> {
    const caller = await actor();
    try {
        await access.requireSpace(caller, spaceId, "admin");
        await automations.setAutomationEnabled(automationId, enabled);
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "Could not change the rule");
    }
}

export async function deleteAutomationAction(spaceId: string, automationId: string): Promise<{ error?: string }> {
    const caller = await actor();
    try {
        await access.requireSpace(caller, spaceId, "admin");
        await automations.deleteAutomation(automationId);
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "Could not remove the rule");
    }
}

// ---------------------------------------------------------------------------
// Docs and forms
// ---------------------------------------------------------------------------

export async function createDocAction(input: unknown): Promise<{ id?: string; error?: string }> {
    const caller = await actor();
    const parsed = core.docSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the page and try again" };
    try {
        // A page written inside a folder is authorized against that folder; one
        // the space shares needs the space itself.
        if (parsed.data.folderId) await access.requireFolder(caller, parsed.data.folderId, "member");
        else if (parsed.data.spaceId) await access.requireSpace(caller, parsed.data.spaceId, "member");
        const id = await docs.createDoc(caller.id, parsed.data);
        refresh();
        return { id };
    } catch (caught) {
        return failure(caught, "Could not create the page");
    }
}

export async function updateDocAction(docId: string, input: unknown): Promise<{ error?: string }> {
    const caller = await actor();
    const parsed = core.docSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the page and try again" };
    try {
        if (parsed.data.folderId) await access.requireFolder(caller, parsed.data.folderId, "member");
        else if (parsed.data.spaceId) await access.requireSpace(caller, parsed.data.spaceId, "member");
        await docs.updateDoc(caller.id, docId, parsed.data);
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "Could not save the page");
    }
}

export async function deleteDocAction(docId: string): Promise<{ error?: string }> {
    await actor();
    try {
        await docs.deleteDoc(docId);
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "Could not delete the page");
    }
}

export async function createFormAction(spaceId: string, input: unknown): Promise<{ error?: string }> {
    const caller = await actor();
    const parsed = core.formSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the form and try again" };
    try {
        await access.requireSpace(caller, spaceId, "admin");
        await forms.createForm(spaceId, caller.id, parsed.data);
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "Could not create the form");
    }
}

export async function updateFormAction(spaceId: string, formId: string, input: unknown): Promise<{ error?: string }> {
    const caller = await actor();
    const parsed = core.formSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the form and try again" };
    try {
        await access.requireSpace(caller, spaceId, "admin");
        await forms.updateForm(formId, parsed.data);
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "Could not save the form");
    }
}

export async function deleteFormAction(spaceId: string, formId: string): Promise<{ error?: string }> {
    const caller = await actor();
    try {
        await access.requireSpace(caller, spaceId, "admin");
        await forms.deleteForm(formId);
        refresh();
        return {};
    } catch (caught) {
        return failure(caught, "Could not remove the form");
    }
}
