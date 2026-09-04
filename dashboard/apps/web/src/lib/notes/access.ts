/**
 * Who may reach which writing.
 *
 * Notes have two shelves and they are answered by different rules, which is the
 * whole of this file.
 *
 * **The private shelf** is a note or folder with no `spaceId`. It is what notes
 * were before spaces existed and what a note made from the New note button still
 * is: readable by the account that wrote it and by nobody else, an instance
 * administrator included. There is no role that opens it, because there is
 * nothing to hold a role against - the only check is `ownerId === actor.id`, and
 * `isAdmin` deliberately does not help here. That absence is the feature.
 *
 * **A space** is the other shelf, and it is reached exactly the way a Tasks
 * space is, in the same vocabulary and with the same strongest-wins rule: the
 * person who made it, a membership, a team granted it, whoever runs the
 * organization that owns it, or - on an `internal` one - anybody already trusted
 * with the app, which on an organization's shelf means that roster and not the
 * whole instance.
 *
 * Everything else in lib/notes assumes authorization already happened and takes
 * the resolved ids, so there is one place that answers "may they".
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { scopeOrgIdFor } from "@/lib/workspace-scope";
import { administeredOrgIds, memberOrgIds } from "@/lib/orgs/org-service";

/** The caller, as the action layer resolved them. */
export interface NoteActor {
    readonly id: string;
    readonly isAdmin: boolean;
}

/** A space's owner outranks every role; an instance admin is treated as one so
 *  an operator is never locked out of a shared shelf on the instance they run.
 *  It reaches no private shelf - see the note at the top. */
export type NoteAccess = core.SpaceRole | "owner";

export class NoteAccessError extends Error {
    constructor(message = "You do not have access to that notebook") {
        super(message);
        this.name = "NoteAccessError";
    }
}

function atLeast(role: NoteAccess, minimum: core.SpaceRole): boolean {
    return role === "owner" || core.spaceRoleAtLeast(role, minimum);
}

/**
 * Whether the role this actor holds in an organization carries a permission,
 * answered from what the space query already fetched rather than from a second
 * round trip per row.
 *
 * Read off the role's grants and never off its name: an organization names its
 * own roles, and matching on "admin" lists a shelf to somebody the roster says
 * runs the work and then refuses them when they open it.
 */
function orgRoleGrants(
    org: { members: { role: string }[]; roles: { slug: string; permissions: string }[] },
    permission: core.OrgPermission
): boolean {
    const slug = org.members[0]?.role;
    if (!slug) return false;
    const row = org.roles.find((role) => role.slug === slug);
    if (!row) return core.hasOrgPermission(core.ORG_SYSTEM_ROLES[slug]?.permissions ?? [], permission);
    try {
        return core.hasOrgPermission(JSON.parse(row.permissions) as string[], permission);
    } catch {
        // A row nobody can read grants nothing, rather than everything.
        return false;
    }
}

/**
 * What this actor may do across a whole space, or null when it is not theirs to
 * see.
 *
 * Every way in is considered together and the strongest wins, because they are
 * additive by design: somebody can be a guest through an organization and a
 * member through a team, and the answer has to be member.
 */
export async function resolveSpaceRole(actor: NoteActor, spaceId: string): Promise<NoteAccess | null> {
    const space = await prisma.noteSpace.findUnique({
        where: { id: spaceId },
        select: {
            ownerId: true,
            visibility: true,
            orgId: true,
            members: { where: { userId: actor.id }, select: { role: true } },
            teamGrants: {
                where: { team: { members: { some: { userId: actor.id } } } },
                select: { role: true }
            },
            org: {
                select: {
                    ownerId: true,
                    members: { where: { userId: actor.id }, select: { role: true } },
                    roles: { select: { slug: true, permissions: true } }
                }
            }
        }
    });
    if (!space) return null;
    if (space.ownerId === actor.id || actor.isAdmin) return "owner";
    if (space.org) {
        if (space.org.ownerId === actor.id) return "owner";
        if (orgRoleGrants(space.org, "spaces.manage")) return "admin";
    }

    let role: core.SpaceRole | null = (space.members[0]?.role as core.SpaceRole | undefined) ?? null;
    for (const grant of space.teamGrants) {
        const granted = grant.role as core.SpaceRole;
        role = role ? core.strongerRole(role, granted) : granted;
    }
    if (role) return role;

    if (space.visibility !== "internal") return null;
    if (!space.orgId) return "guest";
    return space.org && space.org.members.length > 0 ? "guest" : null;
}

export async function requireSpace(
    actor: NoteActor,
    spaceId: string,
    minimum: core.SpaceRole
): Promise<NoteAccess> {
    const role = await resolveSpaceRole(actor, spaceId);
    if (!role) throw new NoteAccessError();
    if (!atLeast(role, minimum)) throw new NoteAccessError("You cannot make that change here");
    return role;
}

/**
 * The shelf check every read and write goes through: a space id and the account
 * a row belongs to, judged together.
 *
 * A null space is the private shelf and only its owner passes, whatever role
 * they hold anywhere else. This is the one function that must be reached for
 * when a row could be on either shelf, which is most of them.
 */
export async function requireShelf(
    actor: NoteActor,
    shelf: { spaceId: string | null; ownerId: string },
    minimum: core.SpaceRole
): Promise<NoteAccess | "self"> {
    if (!shelf.spaceId) {
        if (shelf.ownerId !== actor.id) throw new NoteAccessError("That is not yours to open");
        return "self";
    }
    return requireSpace(actor, shelf.spaceId, minimum);
}

/** Every space this account may read, archived ones included so a link to one
 *  still opens. Authorization, never narrowed by the open shelf. */
export async function visibleSpaceIds(actor: NoteActor): Promise<string[]> {
    if (actor.isAdmin) {
        const all = await prisma.noteSpace.findMany({ select: { id: true } });
        return all.map((space) => space.id);
    }
    const [administered, onRoster] = await Promise.all([
        administeredOrgIds(actor),
        memberOrgIds(actor.id)
    ]);
    const spaces = await prisma.noteSpace.findMany({
        where: {
            OR: [
                { ownerId: actor.id },
                { members: { some: { userId: actor.id } } },
                { teamGrants: { some: { team: { members: { some: { userId: actor.id } } } } } },
                { orgId: { in: administered } },
                // An internal shelf with no organization is the instance-wide
                // case; one with an organization is internal to that roster only.
                { visibility: "internal", orgId: null },
                { visibility: "internal", orgId: { in: onRoster } }
            ]
        },
        select: { id: true }
    });
    return spaces.map((space) => space.id);
}

/**
 * The same, narrowed to the shelf the reader is working from.
 *
 * Two functions rather than one because they answer different questions.
 * `visibleSpaceIds` is authorization and must never move, or a pasted link to a
 * note would stop opening depending on which workspace happened to be selected.
 * This one is presentation: what the sidebar lists. It only ever intersects,
 * never widens.
 */
export async function shelfSpaceIds(actor: NoteActor): Promise<string[]> {
    const visible = await visibleSpaceIds(actor);
    if (visible.length === 0) return visible;
    const orgId = await scopeOrgIdFor(actor.id);
    const onShelf = await prisma.noteSpace.findMany({
        where: { id: { in: visible }, orgId },
        select: { id: true }
    });
    return onShelf.map((space) => space.id);
}

/** A note, with the shelf it sits on, once the actor has been allowed to touch
 *  it. Throws rather than returning null: every caller redirects or fails, and
 *  a boolean at this depth is a check somebody forgets to read. */
export async function requireNote(
    actor: NoteActor,
    noteId: string,
    minimum: core.SpaceRole
): Promise<{ noteId: string; spaceId: string | null; folderId: string | null; ownerId: string }> {
    const note = await prisma.note.findUnique({
        where: { id: noteId },
        select: { id: true, userId: true, spaceId: true, folderId: true }
    });
    if (!note) throw new NoteAccessError("That note no longer exists");
    await requireShelf(actor, { spaceId: note.spaceId, ownerId: note.userId }, minimum);
    return { noteId: note.id, spaceId: note.spaceId, folderId: note.folderId, ownerId: note.userId };
}

export async function requireFolder(
    actor: NoteActor,
    folderId: string,
    minimum: core.SpaceRole
): Promise<{ folderId: string; spaceId: string | null; parentId: string | null; ownerId: string }> {
    const folder = await prisma.noteFolder.findUnique({
        where: { id: folderId },
        select: { id: true, ownerId: true, spaceId: true, parentId: true }
    });
    if (!folder) throw new NoteAccessError("That folder no longer exists");
    await requireShelf(actor, { spaceId: folder.spaceId, ownerId: folder.ownerId }, minimum);
    return {
        folderId: folder.id,
        spaceId: folder.spaceId,
        parentId: folder.parentId,
        ownerId: folder.ownerId
    };
}

/**
 * The check a write into a shelf makes before it creates anything.
 *
 * Creating is a `member` action on a space and always allowed on your own
 * private shelf. A folder named as the destination has to be on the shelf the
 * caller said it was: a request that names somebody else's folder and a space
 * the caller can write to would otherwise file the note where it does not
 * belong.
 */
export async function requirePlacement(
    actor: NoteActor,
    placement: { spaceId: string | null; folderId: string | null }
): Promise<void> {
    if (placement.spaceId) await requireSpace(actor, placement.spaceId, "member");
    if (!placement.folderId) return;
    const folder = await requireFolder(actor, placement.folderId, "member");
    if ((folder.spaceId ?? null) !== (placement.spaceId ?? null)) {
        throw new NoteAccessError("That folder is on a different notebook");
    }
}
