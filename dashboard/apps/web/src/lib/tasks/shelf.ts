/**
 * Which shelf a piece of Tasks work sits on, for filing an alert about it.
 *
 * A space belongs to an organization or to nobody, and the shelf switch lists
 * spaces by exactly that (`shelfScope` in `access`), so an alert about a task is
 * filed the same way: a company's task is counted on that company's shelf, a
 * personal space's on the personal one. See `lib/shelf` for the rule.
 *
 * Undefined when the work is gone, which files the alert about the account -
 * shown everywhere rather than nowhere.
 */

import { prisma } from "@polaris/db";

export type WorkShelf = { readonly orgId: string | null } | undefined;

export async function spaceShelf(spaceId: string | null): Promise<WorkShelf> {
    if (!spaceId) return undefined;
    const space = await prisma.taskSpace.findUnique({ where: { id: spaceId }, select: { orgId: true } });
    return space ? { orgId: space.orgId } : undefined;
}

export async function taskShelf(taskId: string): Promise<WorkShelf> {
    const task = await prisma.task.findUnique({
        where: { id: taskId },
        select: { space: { select: { orgId: true } } }
    });
    return task ? { orgId: task.space.orgId } : undefined;
}
