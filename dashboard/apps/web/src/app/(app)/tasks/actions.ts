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
import * as orgs from "@/lib/orgs/org-service";
import * as docs from "@/lib/tasks/doc-service";
import * as time from "@/lib/tasks/time-service";
import { recordAudit } from "@/lib/audit-service";
import { prisma } from "@polaris/db";
import { requirePermission, sessionCan } from "@/lib/session";
import { agentOptionsFor, type AgentOption } from "@/lib/agents/agent-readiness";
import { startSessionAction } from "@/app/(app)/apps/agents/sessions/actions";
import * as tasks from "@/lib/tasks/task-service";
import * as views from "@/lib/tasks/view-service";
import * as forms from "@/lib/tasks/form-service";
import * as spaces from "@/lib/tasks/space-service";
import * as shares from "@/lib/tasks/share-service";
import { publishTaskChange } from "@/lib/tasks/live";
import * as commits from "@/lib/tasks/commit-service";
import * as files from "@/lib/tasks/attachment-service";
import * as planning from "@/lib/tasks/planning-service";
import * as details from "@/lib/tasks/task-detail-service";
import * as automations from "@/lib/tasks/automation-service";

const TASKS_PATH = "/tasks";

/** The caller, once the instance permission has been established. */
async function actor(
    permission: "tasks.read" | "tasks.manage" = "tasks.manage"
): Promise<access.TaskActor> {
    const user = await requirePermission(permission);
    return { id: user.id, isAdmin: user.isAdmin };
}

/** Turn whatever went wrong into one line the user can act on. Service errors
 *  are written for people and pass through; anything else is a bug and is
 *  logged rather than shown. */
function failure(caught: unknown, fallback: string): { error: string } {
    if (caught instanceof access.TaskAccessError) return { error: caught.message };
    if (caught instanceof Error && caught.message && !caught.message.includes("\n"))
        return { error: caught.message };
    console.error(caught);
    return { error: fallback };
}

/**
 * Refresh the screens a change can be visible on, for the person who made it and
 * for everyone else looking at the same work.
 *
 * The first half is this tab: revalidating the subtree beats trying to guess
 * which page the user is on, and the app is small enough for that to be cheap.
 * The second half is the team's tabs, which are holding /api/tasks/stream open
 * and are told the space moved - so a task assigned in one browser lands in the
 * assignee's without them reloading.
 *
 * `where` names the space or spaces the write touched, and it is what keeps a
 * change in one team's space from re-rendering another team's screen. A write
 * with no space is a write nothing else can see - a goal or a page somebody
 * keeps to themselves, a timer that was not running - so it announces nothing
 * rather than waking the whole instance to look at something private.
 */
function refresh(
    caller: access.TaskActor,
    where?: string | readonly (string | null)[] | null
): void {
    revalidatePath(TASKS_PATH, "layout");
    const named = typeof where === "string" ? [where] : (where ?? []);
    for (const spaceId of new Set(named.filter((id): id is string => Boolean(id)))) {
        publishTaskChange({ spaceId, actorId: caller.id });
    }
}

// ---------------------------------------------------------------------------
// Spaces, folders, lists
// ---------------------------------------------------------------------------

export async function createSpaceAction(input: unknown): Promise<{ id?: string; error?: string }> {
    const caller = await actor();
    const parsed = core.spaceSchema.safeParse(input);
    if (!parsed.success)
        return { error: parsed.error.issues[0]?.message ?? "Check the details and try again" };
    try {
        // Creating work on an organization's behalf takes being allowed to run
        // its work, so somebody who merely belongs to it cannot put a space
        // nobody asked for on the group's shelf.
        if (parsed.data.orgId)
            await orgs.requireOrgPermission(caller, parsed.data.orgId, "spaces.manage");
        const created = await spaces.createSpace(caller.id, parsed.data);
        // Stamped with the organization when it has one, so the group's own
        // history records the work being made rather than only the maker's.
        await recordAudit({
            actorId: caller.id,
            orgId: parsed.data.orgId ?? undefined,
            action: "tasks.space.create",
            targetType: "space",
            targetId: created.id
        });
        refresh(caller, created.id);
        return { id: created.id };
    } catch (caught) {
        return failure(caught, "Could not create the space");
    }
}

export async function updateSpaceAction(
    spaceId: string,
    input: unknown
): Promise<{ error?: string }> {
    const caller = await actor();
    const parsed = core.spaceSchema.safeParse(input);
    if (!parsed.success)
        return { error: parsed.error.issues[0]?.message ?? "Check the details and try again" };
    try {
        await access.requireSpace(caller, spaceId, "admin");
        await spaces.updateSpace(spaceId, parsed.data);
        refresh(caller, spaceId);
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
        await recordAudit({
            actorId: caller.id,
            action: "tasks.space.delete",
            targetType: "space",
            targetId: spaceId
        });
        refresh(caller, spaceId);
        return {};
    } catch (caught) {
        return failure(caught, "Could not delete the space");
    }
}

/**
 * Who is on a space, for the dialog that opens on a right-click.
 *
 * The settings screen reads this on the server, where it is already holding the
 * space. The dialog cannot: it is opened from a tree that has only a name and an
 * id, and it opens for whichever row was clicked.
 *
 * Reading it is `guest`, the same as the folder one: seeing who else is here is
 * part of being here, and hiding the list from the people in it only means they
 * ask in chat instead. Changing it still takes `admin`.
 */
export async function listSpaceMembersAction(spaceId: string): Promise<{
    space?: { id: string; name: string };
    members?: spaces.SpaceMemberView[];
    canManage?: boolean;
    error?: string;
}> {
    const caller = await actor("tasks.read");
    try {
        const role = await access.requireSpace(caller, spaceId, "guest");
        const [space, members] = await Promise.all([
            spaces.getSpace(spaceId),
            spaces.listSpaceMembers(spaceId, caller)
        ]);
        const canManage = role === "owner" || role === "admin";
        return space ? { space, members, canManage } : { error: "That space no longer exists" };
    } catch (caught) {
        return failure(caught, "Could not read who has access");
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
        refresh(caller, spaceId);
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
        refresh(caller, spaceId);
        return {};
    } catch (caught) {
        return failure(caught, "Could not change that role");
    }
}

export async function removeSpaceMemberAction(
    spaceId: string,
    userId: string
): Promise<{ error?: string }> {
    const caller = await actor();
    try {
        await access.requireSpace(caller, spaceId, "admin");
        await spaces.removeSpaceMember(spaceId, userId);
        refresh(caller, spaceId);
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
        if (parsed.data.parentId)
            await access.requireFolder(caller, parsed.data.parentId, "member");
        else await access.requireSpace(caller, parsed.data.spaceId, "member");
        const id = await spaces.createFolder(parsed.data);
        refresh(caller, parsed.data.spaceId);
        return { id };
    } catch (caught) {
        return failure(caught, "Could not create the folder");
    }
}

export async function renameFolderAction(
    folderId: string,
    name: string
): Promise<{ error?: string }> {
    const caller = await actor();
    const parsed = core.containerName.safeParse(name);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Enter a name" };
    try {
        const { spaceId } = await access.requireFolder(caller, folderId, "member");
        await spaces.renameFolder(folderId, parsed.data);
        refresh(caller, spaceId);
        return {};
    } catch (caught) {
        return failure(caught, "Could not rename the folder");
    }
}

export async function deleteFolderAction(folderId: string): Promise<{ error?: string }> {
    const caller = await actor();
    try {
        const { spaceId } = await access.requireFolder(caller, folderId, "admin");
        await spaces.deleteFolder(folderId);
        refresh(caller, spaceId);
        return {};
    } catch (caught) {
        return failure(caught, "Could not delete the folder");
    }
}

/** Reparent or reposition a folder after a drag in the sidebar. */
export async function moveFolderAction(
    folderId: string,
    move: unknown
): Promise<{ error?: string }> {
    const caller = await actor();
    const parsed = core.containerMoveSchema.safeParse(move);
    if (!parsed.success) return { error: "Could not work out where that was dropped" };
    try {
        const { spaceId } = await access.requireFolder(caller, folderId, "member");
        // Both ends are checked: dragging out of a branch you may edit into one
        // you may not is still a write to the destination.
        if (parsed.data.parentId)
            await access.requireFolder(caller, parsed.data.parentId, "member");
        else await access.requireSpace(caller, spaceId, "member");
        await spaces.moveFolder(spaceId, folderId, parsed.data);
        refresh(caller, spaceId);
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
        if (parsed.data.parentId)
            await access.requireFolder(caller, parsed.data.parentId, "member");
        else await access.requireSpace(caller, spaceId, "member");
        await spaces.moveList(spaceId, listId, parsed.data);
        refresh(caller, spaceId);
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
    canManage?: boolean;
    error?: string;
}> {
    const caller = await actor("tasks.read");
    try {
        const { role } = await access.requireFolder(caller, folderId, "guest");
        const [folder, members] = await Promise.all([
            spaces.getFolder(folderId),
            spaces.listFolderMembers(folderId, caller)
        ]);
        const canManage = role === "owner" || role === "admin";
        return folder ? { folder, members, canManage } : { error: "That folder no longer exists" };
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
        const { spaceId } = await access.requireFolder(caller, folderId, "admin");
        await spaces.addFolderMember(folderId, identifier, role);
        await recordAudit({
            actorId: caller.id,
            action: "tasks.folder.invite",
            targetType: "folder",
            targetId: folderId
        });
        refresh(caller, spaceId);
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
        const { spaceId } = await access.requireFolder(caller, folderId, "admin");
        await spaces.setFolderMemberRole(folderId, userId, role);
        refresh(caller, spaceId);
        return {};
    } catch (caught) {
        return failure(caught, "Could not change that role");
    }
}

export async function removeFolderMemberAction(
    folderId: string,
    userId: string
): Promise<{ error?: string }> {
    const caller = await actor();
    try {
        const { spaceId } = await access.requireFolder(caller, folderId, "admin");
        await spaces.removeFolderMember(folderId, userId);
        refresh(caller, spaceId);
        return {};
    } catch (caught) {
        return failure(caught, "Could not remove that person");
    }
}

/** Who a new space could belong to besides the person making it. Fetched when
 *  the create form opens rather than sent with every page, because most people
 *  are in no organization at all and the form then asks nothing extra. */
export async function spaceOwnerOptionsAction(): Promise<{
    orgs?: { id: string; name: string }[];
    error?: string;
}> {
    const caller = await actor();
    try {
        return { orgs: await orgs.listAdministeredOrgs(caller) };
    } catch (caught) {
        return failure(caught, "Could not read your organizations");
    }
}

// ---------------------------------------------------------------------------
// Team grants
// ---------------------------------------------------------------------------

/**
 * Hand a whole space to a team, or change the role it carries there.
 *
 * Both ends are checked. Administering the space is what lets somebody give it
 * away, and the team has to belong to the organization that owns the space -
 * otherwise a space admin could grant their work to a team on somebody else's
 * roster, which is an invitation nobody in that organization agreed to.
 */
export async function grantSpaceTeamAction(
    spaceId: string,
    teamId: string,
    role: core.SpaceRole
): Promise<{ error?: string }> {
    const caller = await actor();
    if (!(core.SPACE_ROLES as readonly string[]).includes(role)) return { error: "Pick a role" };
    try {
        await access.requireSpace(caller, spaceId, "admin");
        const eligible = await orgs.teamsForSpace(spaceId);
        if (!eligible.some((team) => team.id === teamId)) {
            return { error: "That team is not part of the organization this space belongs to" };
        }
        await orgs.grantTeamSpace(teamId, spaceId, role);
        refresh(caller, spaceId);
        return {};
    } catch (caught) {
        return failure(caught, "Could not give the team access");
    }
}

export async function revokeSpaceTeamAction(
    spaceId: string,
    teamId: string
): Promise<{ error?: string }> {
    const caller = await actor();
    try {
        await access.requireSpace(caller, spaceId, "admin");
        await orgs.revokeTeamSpace(teamId, spaceId);
        refresh(caller, spaceId);
        return {};
    } catch (caught) {
        return failure(caught, "Could not take the team's access away");
    }
}

/** The same for one branch, so a project inside a shared space goes to the team
 *  that works it without opening the rest. */
export async function grantFolderTeamAction(
    folderId: string,
    teamId: string,
    role: core.SpaceRole
): Promise<{ error?: string }> {
    const caller = await actor();
    if (!(core.SPACE_ROLES as readonly string[]).includes(role)) return { error: "Pick a role" };
    try {
        const { spaceId } = await access.requireFolder(caller, folderId, "admin");
        const eligible = await orgs.teamsForSpace(spaceId);
        if (!eligible.some((team) => team.id === teamId)) {
            return { error: "That team is not part of the organization this space belongs to" };
        }
        await orgs.grantTeamFolder(teamId, folderId, role);
        refresh(caller, spaceId);
        return {};
    } catch (caught) {
        return failure(caught, "Could not give the team access");
    }
}

export async function revokeFolderTeamAction(
    folderId: string,
    teamId: string
): Promise<{ error?: string }> {
    const caller = await actor();
    try {
        const { spaceId } = await access.requireFolder(caller, folderId, "admin");
        await orgs.revokeTeamFolder(teamId, folderId);
        refresh(caller, spaceId);
        return {};
    } catch (caught) {
        return failure(caught, "Could not take the team's access away");
    }
}

/** Which teams hold this space and which could, so the access panel can be
 *  drawn in one round trip. Empty for a personal space, which is what makes the
 *  panel explain itself rather than show an empty picker. */
export async function spaceTeamsAction(spaceId: string): Promise<{
    granted?: { teamId: string; teamName: string; role: core.SpaceRole }[];
    available?: { id: string; name: string }[];
    error?: string;
}> {
    const caller = await actor("tasks.read");
    try {
        await access.requireSpace(caller, spaceId, "guest");
        const [granted, available] = await Promise.all([
            orgs.spaceTeamGrants(spaceId),
            orgs.teamsForSpace(spaceId)
        ]);
        return { granted, available };
    } catch (caught) {
        return failure(caught, "Could not read the teams");
    }
}

/** The same, for one folder's access dialog. */
export async function folderTeamsAction(folderId: string): Promise<{
    granted?: { teamId: string; teamName: string; role: core.SpaceRole }[];
    available?: { id: string; name: string }[];
    error?: string;
}> {
    const caller = await actor("tasks.read");
    try {
        const { spaceId } = await access.requireFolder(caller, folderId, "guest");
        const [granted, available] = await Promise.all([
            orgs.folderTeamGrants(folderId),
            orgs.teamsForSpace(spaceId)
        ]);
        return { granted, available };
    } catch (caught) {
        return failure(caught, "Could not read the teams");
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
    if (!parsed.success)
        return { error: parsed.error.issues[0]?.message ?? "Check the details and try again" };
    try {
        // Authorized against the folder it goes into when there is one, so
        // somebody invited to a single project can add a list inside it without
        // being handed the space around it.
        if (parsed.data.folderId)
            await access.requireFolder(caller, parsed.data.folderId, "member");
        else await access.requireSpace(caller, parsed.data.spaceId, "member");
        const id = await spaces.createList(parsed.data);
        refresh(caller, parsed.data.spaceId);
        return { id };
    } catch (caught) {
        return failure(caught, "Could not create the list");
    }
}

/**
 * The list a task created on a space or a folder goes into, made if that
 * container holds none. Authorized exactly as creating a list is, because when
 * there is nothing there yet that is what this does.
 */
export async function ensureListAction(
    spaceId: unknown,
    folderId: unknown
): Promise<{ list?: { id: string; name: string }; error?: string }> {
    const caller = await actor();
    const parsed = core.listSchema.safeParse({ spaceId, folderId, name: core.DEFAULT_LIST_NAME });
    if (!parsed.success)
        return { error: parsed.error.issues[0]?.message ?? "Check the details and try again" };
    try {
        if (parsed.data.folderId)
            await access.requireFolder(caller, parsed.data.folderId, "member");
        else await access.requireSpace(caller, parsed.data.spaceId, "member");
        const list = await spaces.ensureList(parsed.data);
        refresh(caller, parsed.data.spaceId);
        return { list };
    } catch (caught) {
        return failure(caught, "Could not make a list for the task");
    }
}

export async function updateListAction(
    listId: string,
    input: unknown
): Promise<{ error?: string }> {
    const caller = await actor();
    try {
        const { spaceId } = await access.requireList(caller, listId, "member");
        const parsed = core.listSchema.safeParse({ ...(input as object), spaceId });
        if (!parsed.success)
            return { error: parsed.error.issues[0]?.message ?? "Check the details and try again" };
        await spaces.updateList(listId, parsed.data);
        refresh(caller, spaceId);
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
        const { spaceId } = await access.requireList(caller, listId, "member");
        await spaces.renameList(listId, parsed.data);
        refresh(caller, spaceId);
        return {};
    } catch (caught) {
        return failure(caught, "Could not rename the list");
    }
}

export async function renameSpaceAction(
    spaceId: string,
    name: string
): Promise<{ error?: string }> {
    const caller = await actor();
    const parsed = core.containerName.safeParse(name);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Enter a name" };
    try {
        await access.requireSpace(caller, spaceId, "admin");
        await spaces.renameSpace(spaceId, parsed.data);
        refresh(caller, spaceId);
        return {};
    } catch (caught) {
        return failure(caught, "Could not rename the space");
    }
}

export async function deleteListAction(listId: string): Promise<{ error?: string }> {
    const caller = await actor();
    try {
        const { spaceId } = await access.requireList(caller, listId, "admin");
        await spaces.deleteList(listId);
        refresh(caller, spaceId);
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
    if (!parsed.success)
        return { error: parsed.error.issues[0]?.message ?? "Check the status and try again" };
    try {
        await access.requireSpace(caller, spaceId, "admin");
        const id = await spaces.createStatus(
            spaceId,
            parsed.data.name,
            parsed.data.type,
            parsed.data.color
        );
        refresh(caller, spaceId);
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
    if (!parsed.success)
        return { error: parsed.error.issues[0]?.message ?? "Check the status and try again" };
    try {
        await access.requireSpace(caller, spaceId, "admin");
        await spaces.updateStatus(spaceId, statusId, parsed.data);
        refresh(caller, spaceId);
        return {};
    } catch (caught) {
        return failure(caught, "Could not save the status");
    }
}

export async function deleteStatusAction(
    spaceId: string,
    statusId: string,
    fate: spaces.ColumnWorkFate
): Promise<{ error?: string }> {
    const caller = await actor();
    if (fate.kind !== "move" && fate.kind !== "archive" && fate.kind !== "delete") {
        return { error: "Say what to do with the work on it" };
    }
    try {
        await access.requireSpace(caller, spaceId, "admin");
        await spaces.deleteStatus(spaceId, statusId, fate);
        refresh(caller, spaceId);
        return {};
    } catch (caught) {
        return failure(caught, "Could not remove the status");
    }
}

export async function reorderStatusesAction(
    spaceId: string,
    orderedIds: string[]
): Promise<{ error?: string }> {
    const caller = await actor();
    try {
        await access.requireSpace(caller, spaceId, "admin");
        await spaces.reorderStatuses(spaceId, orderedIds);
        refresh(caller, spaceId);
        return {};
    } catch (caught) {
        return failure(caught, "Could not reorder the statuses");
    }
}

export async function createTagAction(
    spaceId: string,
    name: string,
    color: string
): Promise<{ tag?: spaces.TagView; error?: string }> {
    const caller = await actor();
    const parsed = core.tagSchema.safeParse({ spaceId, name, color });
    if (!parsed.success)
        return { error: parsed.error.issues[0]?.message ?? "Check the tag and try again" };
    try {
        await access.requireSpace(caller, spaceId, "member");
        const tag = await spaces.createTag(spaceId, parsed.data.name, parsed.data.color);
        refresh(caller, spaceId);
        return { tag };
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
    if (!parsed.success)
        return { error: parsed.error.issues[0]?.message ?? "Check the tag and try again" };
    try {
        await access.requireSpace(caller, spaceId, "member");
        await spaces.updateTag(spaceId, tagId, parsed.data.name, parsed.data.color);
        refresh(caller, spaceId);
        return {};
    } catch (caught) {
        return failure(caught, "Could not save the tag");
    }
}

export async function deleteTagAction(spaceId: string, tagId: string): Promise<{ error?: string }> {
    const caller = await actor();
    try {
        await access.requireSpace(caller, spaceId, "admin");
        await spaces.deleteTag(spaceId, tagId);
        refresh(caller, spaceId);
        return {};
    } catch (caught) {
        return failure(caught, "Could not remove the tag");
    }
}

export async function createCustomFieldAction(input: unknown): Promise<{ error?: string }> {
    const caller = await actor();
    const parsed = core.customFieldSchema.safeParse(input);
    if (!parsed.success)
        return { error: parsed.error.issues[0]?.message ?? "Check the field and try again" };
    try {
        await access.requireSpace(caller, parsed.data.spaceId, "admin");
        await spaces.createCustomField(parsed.data);
        refresh(caller, parsed.data.spaceId);
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
    if (!parsed.success)
        return { error: parsed.error.issues[0]?.message ?? "Check the field and try again" };
    try {
        await access.requireSpace(caller, spaceId, "admin");
        await spaces.updateCustomField(spaceId, fieldId, parsed.data);
        refresh(caller, spaceId);
        return {};
    } catch (caught) {
        return failure(caught, "Could not save the field");
    }
}

export async function deleteCustomFieldAction(
    spaceId: string,
    fieldId: string
): Promise<{ error?: string }> {
    const caller = await actor();
    try {
        await access.requireSpace(caller, spaceId, "admin");
        await spaces.deleteCustomField(spaceId, fieldId);
        refresh(caller, spaceId);
        return {};
    } catch (caught) {
        return failure(caught, "Could not remove the field");
    }
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export async function createTaskAction(
    input: unknown
): Promise<{ id?: string; reference?: string; error?: string }> {
    const caller = await actor();
    const parsed = core.taskCreateSchema.safeParse(input);
    if (!parsed.success)
        return { error: parsed.error.issues[0]?.message ?? "Check the task and try again" };
    try {
        const { spaceId } = await access.requireList(caller, parsed.data.listId, "member");
        const created = await tasks.createTask(caller.id, spaceId, parsed.data);
        refresh(caller, spaceId);
        return created;
    } catch (caught) {
        return failure(caught, "Could not create the task");
    }
}

export async function updateTaskAction(input: unknown): Promise<{ error?: string }> {
    const caller = await actor();
    const parsed = core.taskUpdateSchema.safeParse(input);
    if (!parsed.success)
        return { error: parsed.error.issues[0]?.message ?? "Check the task and try again" };
    try {
        const { spaceId } = await access.requireTask(caller, parsed.data.taskId, "member");
        await tasks.updateTask(caller.id, parsed.data);
        refresh(caller, spaceId);
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
        const { spaceId } = await access.requireTask(caller, parsed.data.taskId, "member");
        await tasks.moveTask(caller.id, parsed.data);
        refresh(caller, spaceId);
        return {};
    } catch (caught) {
        return failure(caught, "Could not move the task");
    }
}

/** Keep the order a screen was showing, because somebody just dragged a task
 *  into it. Ordering work is changing it, so it takes the same membership as
 *  every other task write, and an id the caller may not write drops out of the
 *  arrangement rather than failing the drag. */
export async function arrangeTasksAction(input: unknown): Promise<{ error?: string }> {
    const caller = await actor();
    const parsed = core.taskArrangeSchema.safeParse(input);
    if (!parsed.success) return { error: "Could not work out the order that was dropped into" };
    try {
        const cleared = await access.writableTasks(caller, parsed.data.taskIds, "member");
        const writable = new Set(cleared.map((task) => task.id));
        await tasks.arrangeTasks(parsed.data.taskIds.filter((id) => writable.has(id)));
        refresh(
            caller,
            cleared.map((task) => task.spaceId)
        );
        return {};
    } catch (caught) {
        return failure(caught, "Could not keep that order");
    }
}

export async function bulkUpdateAction(
    input: unknown
): Promise<{ count?: number; error?: string }> {
    const caller = await actor();
    const parsed = core.taskBulkSchema.safeParse(input);
    if (!parsed.success) return { error: "Check the selection and try again" };
    try {
        const writable = await access.writableTasks(caller, parsed.data.taskIds, "member");
        // Moving a selection into a list is a write on that list too, and the
        // destination arrives from the browser like the rest of it.
        if (parsed.data.listId) await access.requireList(caller, parsed.data.listId, "member");
        const count = await tasks.bulkUpdate(caller.id, writable, parsed.data);
        refresh(
            caller,
            writable.map((task) => task.spaceId)
        );
        return { count };
    } catch (caught) {
        return failure(caught, "Could not apply that change");
    }
}

/**
 * Paste a selection into a list.
 *
 * Two permissions, not one: whoever pastes has to be able to read every task
 * they copied and to write to the list they are putting it in. The read is the
 * narrowing every other selection goes through - an id that moved out of reach
 * since the screen loaded is left out rather than failing the paste - and the
 * write on the destination is checked outright, because that one is a single
 * place somebody either may or may not put work.
 */
export async function copyTasksAction(
    input: unknown
): Promise<{ report?: tasks.TaskCopyReport; error?: string }> {
    const caller = await actor();
    const parsed = core.taskCopySchema.safeParse(input);
    if (!parsed.success) return { error: "Check the selection and try again" };
    try {
        const destination = await access.requireList(caller, parsed.data.listId, "member");
        const readable = await access.writableTasks(caller, parsed.data.taskIds, "guest");
        if (readable.length === 0) return { error: "None of those tasks are yours to copy" };
        const report = await tasks.copyTasks(
            caller.id,
            readable.map((task) => task.id),
            parsed.data.listId
        );
        refresh(caller, destination.spaceId);
        return { report };
    } catch (caught) {
        return failure(caught, "Could not paste those tasks");
    }
}

/** Delete a selection. The ids arrive from the browser like any other list, so
 *  what is actually deleted is the part of it the caller was cleared to write -
 *  the same narrowing a bulk edit goes through. */
export async function deleteTasksAction(
    input: unknown
): Promise<{ count?: number; error?: string }> {
    const caller = await actor();
    const parsed = core.taskSelectionSchema.safeParse(input);
    if (!parsed.success) return { error: "Check the selection and try again" };
    try {
        const writable = await access.writableTasks(caller, parsed.data.taskIds, "member");
        const count = await tasks.deleteTasks(writable.map((task) => task.id));
        refresh(
            caller,
            writable.map((task) => task.spaceId)
        );
        return { count };
    } catch (caught) {
        return failure(caught, "Could not delete those tasks");
    }
}

export async function deleteTaskAction(taskId: string): Promise<{ error?: string }> {
    const caller = await actor();
    try {
        const { spaceId } = await access.requireTask(caller, taskId, "member");
        await tasks.deleteTask(taskId);
        refresh(caller, spaceId);
        return {};
    } catch (caught) {
        return failure(caught, "Could not delete the task");
    }
}

export async function duplicateTaskAction(
    taskId: string
): Promise<{ id?: string; error?: string }> {
    const caller = await actor();
    try {
        const { spaceId } = await access.requireTask(caller, taskId, "member");
        const id = await tasks.duplicateTask(caller.id, taskId);
        refresh(caller, spaceId);
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

export async function setWatchingAction(
    taskId: string,
    watching: boolean
): Promise<{ error?: string }> {
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
    if (!parsed.success)
        return { error: parsed.error.issues[0]?.message ?? "Write something first" };
    try {
        const { spaceId } = await access.requireTask(caller, parsed.data.taskId, "guest");
        await details.addComment(caller.id, parsed.data);
        refresh(caller, spaceId);
        return {};
    } catch (caught) {
        return failure(caught, "Could not post the comment");
    }
}

export async function editCommentAction(
    taskId: string,
    commentId: string,
    body: string
): Promise<{ error?: string }> {
    const caller = await actor("tasks.read");
    const parsed = core.commentSchema.shape.body.safeParse(body);
    if (!parsed.success)
        return { error: parsed.error.issues[0]?.message ?? "Write something first" };
    try {
        const { spaceId } = await access.requireTask(caller, taskId, "guest");
        await details.editComment(caller.id, commentId, parsed.data);
        refresh(caller, spaceId);
        return {};
    } catch (caught) {
        return failure(caught, "Could not save the comment");
    }
}

export async function deleteCommentAction(
    taskId: string,
    commentId: string
): Promise<{ error?: string }> {
    const caller = await actor("tasks.read");
    try {
        const { role, spaceId } = await access.requireTask(caller, taskId, "guest");
        await details.deleteComment(caller.id, commentId, role === "owner" || role === "admin");
        refresh(caller, spaceId);
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
        const { spaceId } = await access.requireTask(caller, taskId, "guest");
        await details.setCommentResolved(caller.id, commentId, resolved);
        refresh(caller, spaceId);
        return {};
    } catch (caught) {
        return failure(caught, "Could not update the comment");
    }
}

export async function createChecklistAction(
    taskId: string,
    name: string
): Promise<{ error?: string }> {
    const caller = await actor();
    const parsed = core.checklistSchema.safeParse({ taskId, name });
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Enter a name" };
    try {
        const { spaceId } = await access.requireTask(caller, taskId, "member");
        await details.createChecklist(taskId, parsed.data.name);
        refresh(caller, spaceId);
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
        const { spaceId } = await access.requireTask(caller, taskId, "member");
        await details.moveChecklist(taskId, checklistId, parsed.data);
        refresh(caller, spaceId);
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
        const { spaceId } = await access.requireTask(caller, taskId, "member");
        await details.moveChecklistItem(taskId, itemId, parsed.data);
        refresh(caller, spaceId);
        return {};
    } catch (caught) {
        return failure(caught, "Could not move the step");
    }
}

export async function deleteChecklistAction(
    taskId: string,
    checklistId: string
): Promise<{ error?: string }> {
    const caller = await actor();
    try {
        const { spaceId } = await access.requireTask(caller, taskId, "member");
        await details.deleteChecklist(checklistId);
        refresh(caller, spaceId);
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
        const { spaceId } = await access.requireTask(caller, taskId, "member");
        await details.addChecklistItem(checklistId, parsed.data);
        refresh(caller, spaceId);
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
        const { spaceId } = await access.requireTask(caller, taskId, "guest");
        await details.setChecklistItemDone(itemId, done);
        refresh(caller, spaceId);
        return {};
    } catch (caught) {
        return failure(caught, "Could not update the step");
    }
}

export async function deleteChecklistItemAction(
    taskId: string,
    itemId: string
): Promise<{ error?: string }> {
    const caller = await actor();
    try {
        const { spaceId } = await access.requireTask(caller, taskId, "member");
        await details.deleteChecklistItem(itemId);
        refresh(caller, spaceId);
        return {};
    } catch (caught) {
        return failure(caught, "Could not remove the step");
    }
}

/** Promote a checklist step to a task of its own in the same list. */
export async function promoteChecklistItemAction(
    taskId: string,
    itemId: string
): Promise<{ id?: string; error?: string }> {
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
                blockedUntil: null,
                blockedNote: "",
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
        refresh(caller, spaceId);
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
        refresh(caller, spaceId);
        return {};
    } catch (caught) {
        return failure(caught, "Could not link those tasks");
    }
}

export async function removeDependencyAction(
    taskId: string,
    dependencyId: string
): Promise<{ error?: string }> {
    const caller = await actor();
    try {
        const { spaceId } = await access.requireTask(caller, taskId, "member");
        await details.removeDependency(dependencyId);
        refresh(caller, spaceId);
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
        refresh(caller, spaceId);
        return {};
    } catch (caught) {
        return failure(caught, "Could not save that value");
    }
}

export async function addReminderAction(
    taskId: string,
    remindAt: string,
    note: string
): Promise<{ error?: string }> {
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
    if (!parsed.success)
        return { error: parsed.error.issues[0]?.message ?? "Check the details and try again" };
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
    if (!parsed.success)
        return { error: parsed.error.issues[0]?.message ?? "Choose who to send it to" };
    try {
        await access.requireTask(caller, parsed.data.taskId, "member");
        const delivery = await shares.sendTaskByEmail(
            { id: user.id, name: user.name },
            parsed.data
        );
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
export async function deleteAttachmentAction(
    taskId: string,
    attachmentId: string
): Promise<{ error?: string }> {
    const caller = await actor();
    try {
        const { spaceId } = await access.requireTask(caller, taskId, "member");
        const owner = await files.attachmentTaskId(attachmentId);
        // The id came from the client, so it is checked against the task the
        // caller was actually cleared for.
        if (owner !== taskId) return { error: "That file is not on this task" };
        await files.deleteAttachment(attachmentId);
        refresh(caller, spaceId);
        return {};
    } catch (caught) {
        return failure(caught, "Could not remove that file");
    }
}

export async function linkCommitAction(
    taskId: string,
    reference: string
): Promise<{ error?: string }> {
    const caller = await actor();
    try {
        const { spaceId } = await access.requireTask(caller, taskId, "member");
        await commits.linkCommit(taskId, caller.id, reference.slice(0, 500));
        refresh(caller, spaceId);
        return {};
    } catch (caught) {
        if (caught instanceof commits.CommitLinkError) return { error: caught.message };
        return failure(caught, "Could not link that commit");
    }
}

export async function unlinkCommitAction(
    taskId: string,
    commitId: string
): Promise<{ error?: string }> {
    const caller = await actor();
    try {
        const { spaceId } = await access.requireTask(caller, taskId, "member");
        await commits.unlinkCommit(taskId, commitId);
        refresh(caller, spaceId);
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
        const { spaceId } = await access.requireTask(caller, taskId, "guest");
        await time.startTimer(caller.id, taskId);
        refresh(caller, spaceId);
        return {};
    } catch (caught) {
        return failure(caught, "Could not start the timer");
    }
}

export async function stopTimerAction(): Promise<{ seconds?: number; error?: string }> {
    const caller = await actor("tasks.read");
    try {
        const { seconds, spaceId } = await time.stopTimer(caller.id);
        refresh(caller, spaceId);
        return { seconds };
    } catch (caught) {
        return failure(caught, "Could not stop the timer");
    }
}

export async function addTimeEntryAction(
    taskId: string,
    duration: string,
    note: string,
    billable: boolean
): Promise<{ error?: string }> {
    const caller = await actor("tasks.read");
    const minutes = core.parseDurationMinutes(duration);
    if (minutes === null || minutes <= 0) return { error: "Enter a length like 1h 30m" };
    const parsed = core.timeEntrySchema.safeParse({
        taskId,
        duration: minutes * 60,
        note,
        billable
    });
    if (!parsed.success) return { error: "Check the entry and try again" };
    try {
        const { spaceId } = await access.requireTask(caller, taskId, "guest");
        await time.addTimeEntry(caller.id, parsed.data);
        refresh(caller, spaceId);
        return {};
    } catch (caught) {
        return failure(caught, "Could not log that time");
    }
}

export async function deleteTimeEntryAction(
    taskId: string,
    entryId: string
): Promise<{ error?: string }> {
    const caller = await actor("tasks.read");
    try {
        const { role, spaceId } = await access.requireTask(caller, taskId, "guest");
        await time.deleteTimeEntry(caller.id, entryId, role === "owner" || role === "admin");
        refresh(caller, spaceId);
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
    if (!parsed.success)
        return { error: parsed.error.issues[0]?.message ?? "Check the view and try again" };
    try {
        let spaceId: string;
        if (parsed.data.listId) {
            spaceId = (await access.requireList(caller, parsed.data.listId, "member")).spaceId;
        } else if (parsed.data.spaceId) {
            await access.requireSpace(caller, parsed.data.spaceId, "member");
            spaceId = parsed.data.spaceId;
        } else return { error: "A view has to belong to a list or a space" };
        const id = await views.createView(caller.id, parsed.data);
        refresh(caller, spaceId);
        return { id };
    } catch (caught) {
        return failure(caught, "Could not save the view");
    }
}

export async function updateViewAction(
    viewId: string,
    input: unknown
): Promise<{ error?: string }> {
    const caller = await actor();
    const parsed = core.taskViewSchema.safeParse(input);
    if (!parsed.success)
        return { error: parsed.error.issues[0]?.message ?? "Check the view and try again" };
    try {
        const existing = await views.getView(viewId);
        if (!existing) return { error: "That view no longer exists" };
        const cleared = existing.listId
            ? await access.requireList(caller, existing.listId, "member")
            : {
                  spaceId: existing.spaceId as string,
                  role: await access.requireSpace(caller, existing.spaceId as string, "member")
              };
        await views.updateView(
            caller.id,
            viewId,
            parsed.data,
            cleared.role === "owner" || cleared.role === "admin"
        );
        refresh(caller, cleared.spaceId);
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
        const cleared = existing.listId
            ? await access.requireList(caller, existing.listId, "member")
            : {
                  spaceId: existing.spaceId as string,
                  role: await access.requireSpace(caller, existing.spaceId as string, "member")
              };
        await views.deleteView(
            caller.id,
            viewId,
            cleared.role === "owner" || cleared.role === "admin"
        );
        refresh(caller, cleared.spaceId);
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
    if (!parsed.success)
        return { error: parsed.error.issues[0]?.message ?? "Check the dates and try again" };
    try {
        // A sprint planning one folder is authorized against that folder, which
        // is what lets a project run its own sprints inside a shared space.
        if (parsed.data.folderId)
            await access.requireFolder(caller, parsed.data.folderId, "member");
        else await access.requireSpace(caller, parsed.data.spaceId, "member");
        await planning.createSprint(parsed.data);
        refresh(caller, parsed.data.spaceId);
        return {};
    } catch (caught) {
        return failure(caught, "Could not create the sprint");
    }
}

export async function updateSprintAction(
    spaceId: string,
    sprintId: string,
    input: unknown
): Promise<{ error?: string }> {
    const caller = await actor();
    const parsed = core.sprintSchema.safeParse({ ...(input as object), spaceId });
    if (!parsed.success)
        return { error: parsed.error.issues[0]?.message ?? "Check the dates and try again" };
    try {
        await access.requireSpace(caller, spaceId, "member");
        await planning.updateSprint(sprintId, parsed.data);
        refresh(caller, spaceId);
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
        refresh(caller, spaceId);
        return {};
    } catch (caught) {
        return failure(caught, "Could not change the sprint");
    }
}

export async function deleteSprintAction(
    spaceId: string,
    sprintId: string
): Promise<{ error?: string }> {
    const caller = await actor();
    try {
        await access.requireSpace(caller, spaceId, "admin");
        await planning.deleteSprint(sprintId);
        refresh(caller, spaceId);
        return {};
    } catch (caught) {
        return failure(caught, "Could not delete the sprint");
    }
}

export async function setTaskSprintAction(
    taskId: string,
    sprintId: string | null
): Promise<{ error?: string }> {
    const caller = await actor();
    try {
        const { spaceId } = await access.requireTask(caller, taskId, "member");
        await planning.setTaskSprint(taskId, sprintId);
        refresh(caller, spaceId);
        return {};
    } catch (caught) {
        return failure(caught, "Could not move that task");
    }
}

/**
 * Clear the caller for a goal they named by id, and answer where it lives.
 *
 * A goal either plans for a space, and then membership of that space is what
 * says who may move it, or it is somebody's own and only they may. The id
 * arrives from the browser like every other, so it is resolved here rather than
 * trusted - holding the instance permission says the app is available, never
 * that a particular goal is.
 */
async function requireGoal(caller: access.TaskActor, goalId: string): Promise<string | null> {
    const goal = await planning.goalOwner(goalId);
    if (!goal) throw new access.TaskAccessError("That goal no longer exists");
    if (goal.spaceId) {
        await access.requireSpace(caller, goal.spaceId, "member");
        return goal.spaceId;
    }
    if (goal.ownerId !== caller.id && !caller.isAdmin) throw new access.TaskAccessError();
    return null;
}

/** The same, for one of a goal's targets. */
async function requireGoalTarget(
    caller: access.TaskActor,
    targetId: string
): Promise<string | null> {
    const target = await planning.goalTargetOwner(targetId);
    if (!target) throw new access.TaskAccessError("That target no longer exists");
    return requireGoal(caller, target.goalId);
}

export async function createGoalAction(input: unknown): Promise<{ id?: string; error?: string }> {
    const caller = await actor();
    const parsed = core.goalSchema.safeParse(input);
    if (!parsed.success)
        return { error: parsed.error.issues[0]?.message ?? "Check the goal and try again" };
    try {
        if (parsed.data.spaceId) await access.requireSpace(caller, parsed.data.spaceId, "member");
        const id = await planning.createGoal(caller.id, parsed.data);
        refresh(caller, parsed.data.spaceId);
        return { id };
    } catch (caught) {
        return failure(caught, "Could not create the goal");
    }
}

export async function updateGoalAction(
    goalId: string,
    input: unknown
): Promise<{ error?: string }> {
    const caller = await actor();
    const parsed = core.goalSchema.safeParse(input);
    if (!parsed.success)
        return { error: parsed.error.issues[0]?.message ?? "Check the goal and try again" };
    try {
        // Both ends: the space the goal is in now, and the one the edit would
        // move it to. Checking only the destination would let anybody adopt a
        // goal out of a space they cannot see.
        const from = await requireGoal(caller, goalId);
        if (parsed.data.spaceId && parsed.data.spaceId !== from) {
            await access.requireSpace(caller, parsed.data.spaceId, "member");
        }
        await planning.updateGoal(goalId, parsed.data);
        refresh(caller, [from, parsed.data.spaceId]);
        return {};
    } catch (caught) {
        return failure(caught, "Could not save the goal");
    }
}

export async function setGoalCompletedAction(
    goalId: string,
    completed: boolean
): Promise<{ error?: string }> {
    const caller = await actor();
    try {
        const spaceId = await requireGoal(caller, goalId);
        await planning.setGoalCompleted(goalId, completed);
        refresh(caller, spaceId);
        return {};
    } catch (caught) {
        return failure(caught, "Could not update the goal");
    }
}

export async function deleteGoalAction(goalId: string): Promise<{ error?: string }> {
    const caller = await actor();
    try {
        const spaceId = await requireGoal(caller, goalId);
        await planning.deleteGoal(goalId);
        refresh(caller, spaceId);
        return {};
    } catch (caught) {
        return failure(caught, "Could not delete the goal");
    }
}

export async function addGoalTargetAction(
    goalId: string,
    input: unknown
): Promise<{ error?: string }> {
    const caller = await actor();
    const parsed = core.goalTargetSchema.safeParse(input);
    if (!parsed.success)
        return { error: parsed.error.issues[0]?.message ?? "Check the target and try again" };
    try {
        const spaceId = await requireGoal(caller, goalId);
        // A `tasks` target counts a list's finished work, so naming one is a read
        // of that list and takes the same clearance as looking at it.
        if (parsed.data.listId) await access.requireList(caller, parsed.data.listId, "guest");
        await planning.addGoalTarget(goalId, parsed.data);
        refresh(caller, spaceId);
        return {};
    } catch (caught) {
        return failure(caught, "Could not add the target");
    }
}

export async function setGoalTargetValueAction(
    targetId: string,
    value: number
): Promise<{ error?: string }> {
    const caller = await actor();
    if (!Number.isFinite(value)) return { error: "Enter a number" };
    try {
        const spaceId = await requireGoalTarget(caller, targetId);
        await planning.setGoalTargetValue(targetId, value);
        refresh(caller, spaceId);
        return {};
    } catch (caught) {
        return failure(caught, "Could not update the target");
    }
}

export async function deleteGoalTargetAction(targetId: string): Promise<{ error?: string }> {
    const caller = await actor();
    try {
        const spaceId = await requireGoalTarget(caller, targetId);
        await planning.deleteGoalTarget(targetId);
        refresh(caller, spaceId);
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
    if (!parsed.success)
        return { error: parsed.error.issues[0]?.message ?? "Check the rule and try again" };
    if (!parsed.data.spaceId) return { error: "A rule has to belong to a space" };
    try {
        await access.requireSpace(caller, parsed.data.spaceId, "admin");
        await automations.createAutomation(parsed.data.spaceId, caller.id, parsed.data);
        refresh(caller, parsed.data.spaceId);
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
    if (!parsed.success)
        return { error: parsed.error.issues[0]?.message ?? "Check the rule and try again" };
    try {
        await access.requireSpace(caller, spaceId, "admin");
        await automations.updateAutomation(automationId, parsed.data);
        refresh(caller, spaceId);
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
        refresh(caller, spaceId);
        return {};
    } catch (caught) {
        return failure(caught, "Could not change the rule");
    }
}

export async function deleteAutomationAction(
    spaceId: string,
    automationId: string
): Promise<{ error?: string }> {
    const caller = await actor();
    try {
        await access.requireSpace(caller, spaceId, "admin");
        await automations.deleteAutomation(automationId);
        refresh(caller, spaceId);
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
    if (!parsed.success)
        return { error: parsed.error.issues[0]?.message ?? "Check the page and try again" };
    try {
        // A page written inside a folder is authorized against that folder; one
        // the space shares needs the space itself.
        if (parsed.data.folderId)
            await access.requireFolder(caller, parsed.data.folderId, "member");
        else if (parsed.data.spaceId)
            await access.requireSpace(caller, parsed.data.spaceId, "member");
        const id = await docs.createDoc(caller.id, parsed.data);
        refresh(caller, parsed.data.spaceId);
        return { id };
    } catch (caught) {
        return failure(caught, "Could not create the page");
    }
}

/**
 * Clear the caller for a page they named by id, and answer which space it is in.
 *
 * Where the page already sits is what decides this, not where the request says
 * it should go: a page inside a folder takes that folder, one the space shares
 * takes the space, and a page belonging to neither is the writer's own. Checking
 * only the payload would let anybody edit any page by describing it as theirs.
 */
async function requireDoc(caller: access.TaskActor, docId: string): Promise<string | null> {
    const doc = await docs.docOwner(docId);
    if (!doc) throw new access.TaskAccessError("That page no longer exists");
    if (doc.folderId) return (await access.requireFolder(caller, doc.folderId, "member")).spaceId;
    if (doc.spaceId) {
        await access.requireSpace(caller, doc.spaceId, "member");
        return doc.spaceId;
    }
    if (doc.createdById !== caller.id && !caller.isAdmin) throw new access.TaskAccessError();
    return null;
}

export async function updateDocAction(docId: string, input: unknown): Promise<{ error?: string }> {
    const caller = await actor();
    const parsed = core.docSchema.safeParse(input);
    if (!parsed.success)
        return { error: parsed.error.issues[0]?.message ?? "Check the page and try again" };
    try {
        // Both ends, because an edit can also move the page: where it is now, and
        // the folder or space it would land in.
        const from = await requireDoc(caller, docId);
        if (parsed.data.folderId)
            await access.requireFolder(caller, parsed.data.folderId, "member");
        else if (parsed.data.spaceId)
            await access.requireSpace(caller, parsed.data.spaceId, "member");
        await docs.updateDoc(caller.id, docId, parsed.data);
        refresh(caller, [from, parsed.data.spaceId]);
        return {};
    } catch (caught) {
        return failure(caught, "Could not save the page");
    }
}

export async function deleteDocAction(docId: string): Promise<{ error?: string }> {
    const caller = await actor();
    try {
        const spaceId = await requireDoc(caller, docId);
        await docs.deleteDoc(docId);
        refresh(caller, spaceId);
        return {};
    } catch (caught) {
        return failure(caught, "Could not delete the page");
    }
}

export async function createFormAction(
    spaceId: string,
    input: unknown
): Promise<{ error?: string }> {
    const caller = await actor();
    const parsed = core.formSchema.safeParse(input);
    if (!parsed.success)
        return { error: parsed.error.issues[0]?.message ?? "Check the form and try again" };
    try {
        await access.requireSpace(caller, spaceId, "admin");
        await forms.createForm(spaceId, caller.id, parsed.data);
        refresh(caller, spaceId);
        return {};
    } catch (caught) {
        return failure(caught, "Could not create the form");
    }
}

export async function updateFormAction(
    spaceId: string,
    formId: string,
    input: unknown
): Promise<{ error?: string }> {
    const caller = await actor();
    const parsed = core.formSchema.safeParse(input);
    if (!parsed.success)
        return { error: parsed.error.issues[0]?.message ?? "Check the form and try again" };
    try {
        await access.requireSpace(caller, spaceId, "admin");
        await forms.updateForm(formId, parsed.data);
        refresh(caller, spaceId);
        return {};
    } catch (caught) {
        return failure(caught, "Could not save the form");
    }
}

export async function deleteFormAction(
    spaceId: string,
    formId: string
): Promise<{ error?: string }> {
    const caller = await actor();
    try {
        await access.requireSpace(caller, spaceId, "admin");
        await forms.deleteForm(formId);
        refresh(caller, spaceId);
        return {};
    } catch (caught) {
        return failure(caught, "Could not remove the form");
    }
}

// ---------------------------------------------------------------------------
// Handing work to an agent
// ---------------------------------------------------------------------------

/**
 * The two questions the handoff dialog has to ask, answered from Tasks.
 *
 * Here rather than reached for across in the Agents app, and not for tidiness: a
 * client component in Tasks that imports another app's server actions drags that
 * whole app's server graph into every screen - and into every test that renders
 * one. Tasks talks to Tasks.
 */
export async function agentHandoffChoicesAction(): Promise<{
    repos: { id: string; name: string }[];
    agents: AgentOption[];
}> {
    const user = await requirePermission("tasks.read");
    // An account with no standing in the Agents app is offered nothing rather
    // than being refused: the button is beside every task, and most people who
    // press it once are finding out what it does.
    const allowed = await sessionCan(user, "agents.manage");
    if (!allowed) return { repos: [], agents: [] };
    const repos = await prisma.agentRepo.findMany({
        where: { ownerId: user.id, enabled: true },
        select: { id: true, repoFullName: true },
        orderBy: { repoFullName: "asc" }
    });
    return {
        repos: repos.map((repo) => ({ id: repo.id, name: repo.repoFullName })),
        // With whether this account can sign each one in, for the same reason the
        // sessions screen carries it: a task handed to an agent nobody can sign
        // in is a task that goes quiet, and the board never learns why.
        agents: await agentOptionsFor(user.id)
    };
}

/** Start a session on a task. The Agents app owns what that means; this is the
 *  door to it from a task, and it is the same door the sessions screen uses. */
export async function handTaskToAgentAction(
    input: unknown
): Promise<{ id?: string; error?: string }> {
    return startSessionAction(input);
}
