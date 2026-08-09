/**
 * Who may reach one particular thing, and whose shelf it sits on.
 *
 * The general form of deploy-project-access, and it exists for the same reason:
 * everything underneath is owner-scoped. A game server's console, a project's
 * volumes, a space's lists are all reached through queries that take an `ownerId`,
 * so somebody who was granted access does not get a second, weaker route in -
 * they are authorized here, and then the existing owner-scoped path runs with the
 * OWNER's id.
 *
 * The decision itself lives in @polaris/auth. What this module adds is the half
 * that cannot: only the web app knows which table a `ResourceKind` names, and only
 * it can tell whether this request is currently previewing a role.
 */

import { cache } from "react";
import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { grantedResourceIds } from "@polaris/auth";
import { requireUser, type SessionUser } from "@/lib/session";
import { effectiveCanOn, effectiveIsAdmin } from "@/lib/effective-access";

export interface ResourceAccess {
    readonly ref: core.ResourceRef;
    /** Whose owner-scoped services this thing's work runs through. */
    readonly ownerId: string;
    readonly isOwner: boolean;
}

/**
 * Where each kind keeps its owner. One entry per kind, so adding a kind is one
 * line rather than a new branch in every caller.
 *
 * Drive is absent on purpose: a Drive reference names a path inside a connection,
 * and its ownership question is already answered by drive-authz with subtree rules
 * this shape cannot express.
 */
const OWNERS: Record<core.ResourceKind, (id: string) => Promise<string | null>> = {
    install: async (id) =>
        (await prisma.installedApp.findFirst({ where: { id }, select: { ownerId: true } }))?.ownerId ?? null,
    project: async (id) =>
        (await prisma.project.findUnique({ where: { id }, select: { ownerId: true } }))?.ownerId ?? null,
    domain: async (id) =>
        (await prisma.ownerDomain.findUnique({ where: { id }, select: { userId: true } }))?.userId ?? null,
    space: async (id) =>
        (await prisma.taskSpace.findUnique({ where: { id }, select: { ownerId: true } }))?.ownerId ?? null,
    drive: async () => null
};

/** The owner of one thing, resolved once per request: a screen asks about the
 *  same server several times over, and none of those should pay for the lookup. */
const ownerOf = cache(async (kind: core.ResourceKind, id: string): Promise<string | null> => OWNERS[kind](id));

/**
 * This user's standing on one thing, or null when they have none.
 *
 * Null covers both "no such thing" and "not yours". Which of the two it was is not
 * something somebody who cannot see it is owed, and saying so would turn the URL
 * into a way to find out what exists.
 */
export async function resourceAccess(
    user: SessionUser,
    ref: core.ResourceRef,
    permission: core.Permission
): Promise<ResourceAccess | null> {
    const ownerId = await ownerOf(ref.kind, ref.id);
    if (!ownerId) return null;
    if (await effectiveIsAdmin(user.id, user.isAdmin)) {
        return { ref, ownerId, isOwner: ownerId === user.id };
    }
    if (!(await effectiveCanOn(user.id, permission, ref, { ownerId }))) return null;
    return { ref, ownerId, isOwner: ownerId === user.id };
}

/** Resolve or refuse, with the one message both cases get. */
export async function requireResource(
    user: SessionUser,
    ref: core.ResourceRef,
    permission: core.Permission
): Promise<ResourceAccess> {
    const access = await resourceAccess(user, ref, permission);
    if (!access) throw new Error("Not found");
    return access;
}

/**
 * The session and the standing on one thing, in the shape a server action wants.
 *
 * Two ids come back and they are not interchangeable. `access.ownerId` is whose
 * shelf the work runs on and belongs in every call that reaches storage, a
 * container, or an owner-scoped query; `user.id` is who is doing it and belongs in
 * every audit entry and `createdById`. Passing the wrong one is the way this goes
 * wrong quietly, so they are handed back separately rather than merged.
 */
export async function requirePermissionOn(
    permission: core.Permission,
    ref: core.ResourceRef
): Promise<{ user: SessionUser; access: ResourceAccess }> {
    const user = await requireUser();
    return { user, access: await requireResource(user, ref, permission) };
}

/** Every permission this user holds on one thing, for a screen deciding which
 *  controls to draw. Resolved through the same decision point as the actions, so a
 *  control is never shown that the action behind it would refuse. */
export async function heldOn(
    user: SessionUser,
    ref: core.ResourceRef,
    candidates: readonly core.Permission[] = core.RESOURCE_KIND_META[ref.kind].actions
): Promise<core.Permission[]> {
    const ownerId = await ownerOf(ref.kind, ref.id);
    if (!ownerId) return [];
    const decided = await Promise.all(
        candidates.map(async (permission) =>
            (await effectiveCanOn(user.id, permission, ref, { ownerId })) ? permission : null
        )
    );
    return decided.filter((permission): permission is core.Permission => permission !== null);
}

/**
 * The things of a kind this user reaches beyond the ones they own, with the owner
 * each of them answers to.
 *
 * What widens a list page. It is deliberately not the whole answer: the detail
 * path still resolves each one through `requireResource`, so a stale grant here
 * can only ever put a row on a list, never open it.
 */
export async function reachableResources(
    user: SessionUser,
    kind: core.ResourceKind,
    permission: core.Permission
): Promise<string[]> {
    // A previewed role holds no grants of its own, and the administrator's must not
    // stand in for it. Nothing beyond what they own, which is what the role says.
    if (user.viewingAs?.mode === "role") return [];
    const { ids, everyOne } = await grantedResourceIds(user.id, kind, permission);
    if (!everyOne) return ids;
    const all = await everyResourceOfKind(kind);
    return [...new Set([...ids, ...all])];
}

/** Every id of a kind, for the rare grant written against all of them. */
async function everyResourceOfKind(kind: core.ResourceKind): Promise<string[]> {
    switch (kind) {
        case "install":
            return (
                await prisma.installedApp.findMany({ where: { status: { not: "removed" } }, select: { id: true } })
            ).map((row) => row.id);
        case "project":
            return (await prisma.project.findMany({ select: { id: true } })).map((row) => row.id);
        case "domain":
            return (await prisma.ownerDomain.findMany({ select: { id: true } })).map((row) => row.id);
        case "space":
            return (await prisma.taskSpace.findMany({ where: { archived: false }, select: { id: true } })).map(
                (row) => row.id
            );
        default:
            return [];
    }
}
