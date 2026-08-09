/**
 * Capability answers for code that only holds a user id.
 *
 * Most of Polaris asks its questions through the resolved session, where a role
 * preview is already accounted for (see sessionCan). Resource authorization does
 * not: `authorizeDrive` is handed an id and reaches for the account behind it.
 * That is correct while an administrator is acting as somebody else - the id is
 * that person's - but it is wrong while a role is being previewed, where the id
 * is still the administrator's and their own admin bypass would answer yes to
 * every question the preview exists to ask honestly.
 *
 * So: the same two questions, answered the way this request is currently seeing
 * Polaris. Resolved once per request - a single Drive operation authorizes
 * several paths, and none of them should pay for the lookup twice.
 */

import { cache } from "react";
import { prisma } from "@polaris/db";
import { resolveSession } from "@/lib/session";
import { resolveViewAs } from "@/lib/view-as-service";
import { canOn, userHasPermission } from "@polaris/auth";
import { hasPermission, type Permission, type ResourceRef } from "@polaris/core";

/** The role standing in for this request's own access, or null. */
const previewedRole = cache(async (): Promise<{ actorId: string; grants: Permission[] } | null> => {
    const session = await resolveSession();
    if (!session) return null;
    const state = await prisma.sessionState.findUnique({
        where: { sessionId: session.sessionId },
        select: { viewAsUserId: true, viewAsRoleId: true, viewAsAt: true }
    });
    // Only a role preview replaces the answer. Acting as another account already
    // carries that account's id into every check.
    if (!state?.viewAsRoleId) return null;
    const view = await resolveViewAs(session, state);
    return view?.mode === "role" ? { actorId: session.id, grants: view.grants ?? [] } : null;
});

/** The grants that stand in for this user's own on this request, or null when
 *  their own are what counts. */
async function standingIn(userId: string): Promise<Permission[] | null> {
    const preview = await previewedRole();
    return preview && preview.actorId === userId ? preview.grants : null;
}

/** Whether this user counts as an administrator right now. A previewed role
 *  never does - that is the first thing a preview has to take away. */
export async function effectiveIsAdmin(userId: string, isAdmin: boolean): Promise<boolean> {
    return (await standingIn(userId)) ? false : isAdmin;
}

/** Whether this user holds a capability right now. */
export async function effectiveCan(userId: string, permission: Permission): Promise<boolean> {
    const grants = await standingIn(userId);
    return grants ? hasPermission(grants, permission) : userHasPermission(userId, permission);
}

/**
 * Whether this user may act on one particular thing right now.
 *
 * A previewed role reaches no resource grant at all. A role is a set of global
 * permissions with no resource dimension, and the grants that do have one belong
 * to the administrator doing the previewing - counting them would show them their
 * own access wearing somebody else's name. What remains is what the role itself
 * says, on the things the account actually owns.
 */
export async function effectiveCanOn(
    userId: string,
    permission: Permission,
    ref: ResourceRef,
    opts?: { ownerId?: string | null }
): Promise<boolean> {
    const grants = await standingIn(userId);
    if (!grants) return canOn(userId, permission, ref, opts);
    return opts?.ownerId === userId && hasPermission(grants, permission);
}
