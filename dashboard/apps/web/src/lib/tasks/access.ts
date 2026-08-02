/**
 * Who may reach which space, and how far in.
 *
 * Two gates stack. The instance permission (`tasks.read` / `tasks.manage`) says
 * whether the app is available to this account at all and is checked by the
 * action layer; the space role says what they may do inside a given space and is
 * checked here. Neither substitutes for the other: holding `tasks.manage` does
 * not put you on somebody else's private space, and being an admin of a space
 * does not grant the app to an account that was never given it.
 *
 * Every other module in lib/tasks assumes authorization already happened and
 * takes the resolved ids, so there is exactly one place that answers "may they".
 */

import { prisma } from "@polaris/db";
import { spaceRoleAtLeast, type SpaceRole } from "@polaris/core";

/** The caller, as the action layer resolved them. */
export interface TaskActor {
    readonly id: string;
    readonly isAdmin: boolean;
}

/** A space owner outranks every role; an instance admin is treated as one so a
 *  operator is never locked out of the instance they run. */
export type SpaceAccess = SpaceRole | "owner";

export class TaskAccessError extends Error {
    constructor(message = "You do not have access to that space") {
        super(message);
        this.name = "TaskAccessError";
    }
}

/** What this actor may do in this space, or null when it is not theirs to see. */
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
    if (membership) return membership.role as SpaceRole;
    // An internal space is readable by anyone the instance already trusts with
    // the app, which is what a single household or team usually wants.
    return space.visibility === "internal" ? "guest" : null;
}

/** Resolve the role or refuse. Returns the role so the caller can branch on it
 *  without a second query. */
export async function requireSpace(actor: TaskActor, spaceId: string, minimum: SpaceRole): Promise<SpaceAccess> {
    const role = await resolveSpaceRole(actor, spaceId);
    if (!role) throw new TaskAccessError();
    if (role !== "owner" && !spaceRoleAtLeast(role, minimum)) {
        throw new TaskAccessError("You do not have permission to do that in this space");
    }
    return role;
}

/** Every space id this actor can see. Used by the cross-space screens (home,
 *  everything, reports) so they never leak a space through an aggregate. */
export async function visibleSpaceIds(actor: TaskActor): Promise<string[]> {
    if (actor.isAdmin) {
        const all = await prisma.taskSpace.findMany({ where: { archived: false }, select: { id: true } });
        return all.map((space) => space.id);
    }
    const spaces = await prisma.taskSpace.findMany({
        where: {
            archived: false,
            OR: [{ ownerId: actor.id }, { members: { some: { userId: actor.id } } }, { visibility: "internal" }]
        },
        select: { id: true }
    });
    return spaces.map((space) => space.id);
}

/** The space a list belongs to, once the actor has been cleared for it. */
export async function requireList(
    actor: TaskActor,
    listId: string,
    minimum: SpaceRole
): Promise<{ listId: string; spaceId: string; role: SpaceAccess }> {
    const list = await prisma.taskList.findUnique({ where: { id: listId }, select: { spaceId: true } });
    if (!list) throw new TaskAccessError("That list no longer exists");
    const role = await requireSpace(actor, list.spaceId, minimum);
    return { listId, spaceId: list.spaceId, role };
}

/** The list and space a task belongs to, once the actor has been cleared. */
export async function requireTask(
    actor: TaskActor,
    taskId: string,
    minimum: SpaceRole
): Promise<{ taskId: string; listId: string; spaceId: string; role: SpaceAccess }> {
    const task = await prisma.task.findUnique({ where: { id: taskId }, select: { listId: true, spaceId: true } });
    if (!task) throw new TaskAccessError("That task no longer exists");
    const role = await requireSpace(actor, task.spaceId, minimum);
    return { taskId, listId: task.listId, spaceId: task.spaceId, role };
}

/**
 * A guest may comment on work and tick their own checklist items, but not
 * reshape it. Rather than scatter that rule, everything that writes a task
 * asks for "member", and the few guest-allowed writes ask for this instead.
 */
export function canComment(role: SpaceAccess): boolean {
    return role === "owner" || spaceRoleAtLeast(role, "guest");
}
