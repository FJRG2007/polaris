/**
 * Who may reach which work, and how far in.
 *
 * Three gates stack. The instance permission (`tasks.read` / `tasks.manage`)
 * says whether the app is available to this account at all and is checked by the
 * action layer. The space role says what they may do across a whole space. The
 * folder grant says what they may do inside one branch of a space and nothing
 * beside it - that is what lets a client be invited to their own folder, or a
 * contractor to a single project, without being shown every other client in the
 * same space.
 *
 * The three never substitute for each other: holding `tasks.manage` does not put
 * you on somebody else's private space, a folder grant never reaches the space's
 * own settings, and a space role is never reduced by a grant sitting under it.
 *
 * Every other module in lib/tasks assumes authorization already happened and
 * takes the resolved ids, so there is exactly one place that answers "may they".
 */

import * as core from "@polaris/core";
import { prisma, type Prisma } from "@polaris/db";

/** The caller, as the action layer resolved them. */
export interface TaskActor {
    readonly id: string;
    readonly isAdmin: boolean;
}

/** A space owner outranks every role; an instance admin is treated as one so an
 *  operator is never locked out of the instance they run. */
export type SpaceAccess = core.SpaceRole | "owner";

export class TaskAccessError extends Error {
    constructor(message = "You do not have access to that space") {
        super(message);
        this.name = "TaskAccessError";
    }
}

function atLeast(role: SpaceAccess, minimum: core.SpaceRole): boolean {
    return role === "owner" || core.spaceRoleAtLeast(role, minimum);
}

// ---------------------------------------------------------------------------
// Space-level access
// ---------------------------------------------------------------------------

/** What this actor may do across this whole space, or null when the space is not
 *  theirs to see. A folder grant deliberately does not answer here. */
export async function resolveSpaceRole(actor: TaskActor, spaceId: string): Promise<SpaceAccess | null> {
    const space = await prisma.taskSpace.findUnique({
        where: { id: spaceId },
        select: {
            ownerId: true,
            visibility: true,
            members: { where: { userId: actor.id }, select: { role: true } }
        }
    });
    if (!space) return null;
    if (space.ownerId === actor.id || actor.isAdmin) return "owner";
    const membership = space.members[0];
    if (membership) return membership.role as core.SpaceRole;
    // An internal space is readable by anyone the instance already trusts with
    // the app, which is what a single household or team usually wants.
    return space.visibility === "internal" ? "guest" : null;
}

/** Resolve the space role or refuse. Returns the role so the caller can branch
 *  on it without a second query. */
export async function requireSpace(actor: TaskActor, spaceId: string, minimum: core.SpaceRole): Promise<SpaceAccess> {
    const role = await resolveSpaceRole(actor, spaceId);
    if (!role) throw new TaskAccessError();
    if (!atLeast(role, minimum)) {
        throw new TaskAccessError("You do not have permission to do that in this space");
    }
    return role;
}

// ---------------------------------------------------------------------------
// Folder grants
// ---------------------------------------------------------------------------

/**
 * Every folder in a space this actor reaches through a grant, mapped to the role
 * it gives them.
 *
 * A grant is inherited: being added to a client folder reaches the projects
 * inside it. Where two grants land on the same chain the stronger one wins,
 * which is what lets somebody be a guest across a client and a member on the one
 * project they are actually working.
 */
async function grantedFolders(actor: TaskActor, spaceId: string): Promise<Map<string, core.SpaceRole>> {
    const [folders, grants] = await Promise.all([
        prisma.taskFolder.findMany({ where: { spaceId }, select: { id: true, parentId: true } }),
        prisma.taskFolderMember.findMany({
            where: { userId: actor.id, folder: { spaceId } },
            select: { folderId: true, role: true }
        })
    ]);
    const reachable = new Map<string, core.SpaceRole>();
    for (const grant of grants) {
        const role = grant.role as core.SpaceRole;
        for (const id of core.folderBranch(folders, grant.folderId)) {
            const existing = reachable.get(id);
            reachable.set(id, existing ? core.strongerRole(existing, role) : role);
        }
    }
    return reachable;
}

/** How a grant on the chain above something combines with what the space itself
 *  gives: the stronger of the two, since a grant is there to reach somebody into
 *  a branch and never to narrow them out of one. */
function withGrant(spaceRole: SpaceAccess | null, granted: core.SpaceRole | null): SpaceAccess | null {
    if (spaceRole === "owner" || !granted) return spaceRole;
    return spaceRole ? core.strongerRole(spaceRole, granted) : granted;
}

/** What this actor may do inside one folder, counting the space role and any
 *  grant on the chain above it. Null when neither reaches. */
async function resolveFolderRole(
    actor: TaskActor,
    spaceId: string,
    folderId: string | null
): Promise<SpaceAccess | null> {
    const spaceRole = await resolveSpaceRole(actor, spaceId);
    if (spaceRole === "owner") return spaceRole;
    // A list at the space root sits under no folder, so only a space role
    // reaches it - a grant on a client folder must not open the whole space.
    if (!folderId) return spaceRole;
    return withGrant(spaceRole, (await grantedFolders(actor, spaceId)).get(folderId) ?? null);
}

/** The space a folder belongs to, once the actor has been cleared for it. */
export async function requireFolder(
    actor: TaskActor,
    folderId: string,
    minimum: core.SpaceRole
): Promise<{ folderId: string; spaceId: string; parentId: string | null; role: SpaceAccess }> {
    const folder = await prisma.taskFolder.findUnique({
        where: { id: folderId },
        select: { spaceId: true, parentId: true }
    });
    if (!folder) throw new TaskAccessError("That folder no longer exists");
    const role = await resolveFolderRole(actor, folder.spaceId, folderId);
    if (!role) throw new TaskAccessError();
    if (!atLeast(role, minimum)) {
        throw new TaskAccessError("You do not have permission to do that in this folder");
    }
    return { folderId, spaceId: folder.spaceId, parentId: folder.parentId, role };
}

// ---------------------------------------------------------------------------
// Lists and tasks
// ---------------------------------------------------------------------------

/** The space a list belongs to, once the actor has been cleared for it. */
export async function requireList(
    actor: TaskActor,
    listId: string,
    minimum: core.SpaceRole
): Promise<{ listId: string; spaceId: string; folderId: string | null; role: SpaceAccess }> {
    const list = await prisma.taskList.findUnique({
        where: { id: listId },
        select: { spaceId: true, folderId: true }
    });
    if (!list) throw new TaskAccessError("That list no longer exists");
    const role = await resolveFolderRole(actor, list.spaceId, list.folderId);
    if (!role) throw new TaskAccessError();
    if (!atLeast(role, minimum)) {
        throw new TaskAccessError("You do not have permission to do that in this space");
    }
    return { listId, spaceId: list.spaceId, folderId: list.folderId, role };
}

/** The list and space a task belongs to, once the actor has been cleared. The
 *  check runs through the task's list, so a grant on a folder covers the work
 *  inside it without a second rule to keep in step. */
export async function requireTask(
    actor: TaskActor,
    taskId: string,
    minimum: core.SpaceRole
): Promise<{ taskId: string; listId: string; spaceId: string; role: SpaceAccess }> {
    const task = await prisma.task.findUnique({ where: { id: taskId }, select: { listId: true } });
    if (!task) throw new TaskAccessError("That task no longer exists");
    const { spaceId, role } = await requireList(actor, task.listId, minimum);
    return { taskId, listId: task.listId, spaceId, role };
}

/**
 * The tasks in a set this actor may change, and nothing beside them.
 *
 * A screen that spans spaces hands a write whatever ids it was showing - a
 * selection, or the arrangement behind a drag - so it cannot ask "may I" one row
 * at a time the way a single-task action does. This answers for the whole set
 * through each task's list, which is the rule requireTask applies to one, so
 * being able to see work is never enough to change it: reaching a space because
 * it is internal makes a guest, and a guest reorders and bulk-edits nothing.
 *
 * Ids that do not clear it are left out rather than refused, because the set is
 * whatever a screen happened to be showing: one row that moved out of reach
 * since it loaded must not fail everything sent with it.
 *
 * Roles are resolved once per space, so a screen spanning several costs a handful
 * of queries rather than one set per row.
 */
export async function writableTasks(
    actor: TaskActor,
    taskIds: readonly string[],
    minimum: core.SpaceRole
): Promise<{ id: string; spaceId: string }[]> {
    if (taskIds.length === 0) return [];
    const tasks = await prisma.task.findMany({
        where: { id: { in: [...taskIds] } },
        select: { id: true, listId: true, spaceId: true }
    });
    if (tasks.length === 0) return [];

    const lists = await prisma.taskList.findMany({
        where: { id: { in: [...new Set(tasks.map((task) => task.listId))] } },
        select: { id: true, spaceId: true, folderId: true }
    });
    const spaceRoles = new Map<string, SpaceAccess | null>();
    const grants = new Map<string, Map<string, core.SpaceRole>>();
    const writableLists = new Set<string>();
    for (const list of lists) {
        if (!spaceRoles.has(list.spaceId)) {
            spaceRoles.set(list.spaceId, await resolveSpaceRole(actor, list.spaceId));
        }
        let role = spaceRoles.get(list.spaceId) ?? null;
        if (role !== "owner" && list.folderId) {
            if (!grants.has(list.spaceId)) grants.set(list.spaceId, await grantedFolders(actor, list.spaceId));
            role = withGrant(role, grants.get(list.spaceId)?.get(list.folderId) ?? null);
        }
        if (role && atLeast(role, minimum)) writableLists.add(list.id);
    }

    return tasks
        .filter((task) => writableLists.has(task.listId))
        .map((task) => ({ id: task.id, spaceId: task.spaceId }));
}

// ---------------------------------------------------------------------------
// What the cross-space screens may read
// ---------------------------------------------------------------------------

/**
 * Everything this actor can see, split by how they can see it.
 *
 * The cross-space screens (home, everything, reports, timesheets) aggregate over
 * more than one space, so they cannot ask "may I" per row. They take this
 * instead: the spaces reachable in full, and - for spaces reached only through a
 * folder grant - the exact lists inside those granted branches. Anything not
 * named here is invisible to those screens, which is what keeps an aggregate
 * from leaking the client sitting in the next folder.
 */
export interface TaskScope {
    /** Spaces the actor reaches in full. */
    readonly spaceIds: string[];
    /** Spaces reached only through a folder grant. */
    readonly partialSpaceIds: string[];
    /** Every folder inside those partial spaces the grants reach, and the role
     *  each one carries once inheritance has been applied. */
    readonly folderRoles: Readonly<Record<string, core.SpaceRole>>;
    /** The lists inside those folders - the only ones readable in a partial space. */
    readonly listIds: string[];
    /** The strongest role the reader holds anywhere inside each partial space,
     *  which is what a screen spanning that space has to render with. */
    readonly partialRoles: Readonly<Record<string, core.SpaceRole>>;
}

const EMPTY_SCOPE: TaskScope = {
    spaceIds: [],
    partialSpaceIds: [],
    folderRoles: {},
    listIds: [],
    partialRoles: {}
};

export async function visibleScope(actor: TaskActor): Promise<TaskScope> {
    if (actor.isAdmin) {
        const all = await prisma.taskSpace.findMany({ where: { archived: false }, select: { id: true } });
        return { ...EMPTY_SCOPE, spaceIds: all.map((space) => space.id) };
    }

    const [full, grants] = await Promise.all([
        prisma.taskSpace.findMany({
            where: {
                archived: false,
                OR: [{ ownerId: actor.id }, { members: { some: { userId: actor.id } } }, { visibility: "internal" }]
            },
            select: { id: true }
        }),
        prisma.taskFolderMember.findMany({
            where: { userId: actor.id, folder: { space: { archived: false } } },
            select: { folderId: true, role: true, folder: { select: { spaceId: true } } }
        })
    ]);

    const spaceIds = full.map((space) => space.id);
    // A grant inside a space the actor already reaches in full adds nothing, and
    // listing it as partial would narrow them instead of widening them.
    const partial = grants.filter((grant) => !spaceIds.includes(grant.folder.spaceId));
    if (partial.length === 0) return { ...EMPTY_SCOPE, spaceIds };

    const partialSpaceIds = [...new Set(partial.map((grant) => grant.folder.spaceId))];
    const folders = await prisma.taskFolder.findMany({
        where: { spaceId: { in: partialSpaceIds }, archived: false },
        select: { id: true, parentId: true }
    });
    const folderRoles: Record<string, core.SpaceRole> = {};
    const partialRoles: Record<string, core.SpaceRole> = {};
    for (const grant of partial) {
        const role = grant.role as core.SpaceRole;
        const spaceId = grant.folder.spaceId;
        const held = partialRoles[spaceId];
        partialRoles[spaceId] = held ? core.strongerRole(held, role) : role;
        for (const id of core.folderBranch(folders, grant.folderId)) {
            const existing = folderRoles[id];
            folderRoles[id] = existing ? core.strongerRole(existing, role) : role;
        }
    }
    const lists = await prisma.taskList.findMany({
        where: { folderId: { in: Object.keys(folderRoles) }, archived: false },
        select: { id: true }
    });

    return {
        spaceIds,
        partialSpaceIds,
        folderRoles,
        listIds: lists.map((list) => list.id),
        partialRoles
    };
}

/** The role a screen spanning one space should render with, whether the reader
 *  holds the space itself or only a branch of it. */
export async function scopedSpaceRole(
    actor: TaskActor,
    scope: TaskScope,
    spaceId: string
): Promise<SpaceAccess | null> {
    const role = await resolveSpaceRole(actor, spaceId);
    return role ?? scope.partialRoles[spaceId] ?? null;
}

/** Every space id that appears in a scope, however the actor reaches it. Used
 *  where the query is space-shaped anyway (statuses, tags, sprints, goals). */
export function scopeSpaceIds(scope: TaskScope): string[] {
    return [...scope.spaceIds, ...scope.partialSpaceIds];
}

/**
 * The scope as a task filter. A row qualifies when it sits in a fully reachable
 * space, or in one of the individually granted lists. Written as an OR so a
 * single query answers both, and returns a clause matching nothing when the
 * scope is empty rather than an empty object, which would match everything.
 */
export function scopeTaskWhere(scope: TaskScope): Prisma.TaskWhereInput {
    const clauses: Prisma.TaskWhereInput[] = [];
    if (scope.spaceIds.length > 0) clauses.push({ spaceId: { in: scope.spaceIds } });
    if (scope.listIds.length > 0) clauses.push({ listId: { in: scope.listIds } });
    return { OR: clauses.length > 0 ? clauses : [{ spaceId: { in: [] } }] };
}
