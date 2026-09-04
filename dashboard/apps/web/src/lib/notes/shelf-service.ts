/**
 * The shelves notes sit on: the private one everybody has, the spaces a group
 * writes on, and the folders filed on either.
 *
 * Authorization is not here - it is `lib/notes/access.ts`, and every function
 * below takes ids that have already been allowed. What is here is the shape the
 * sidebar draws and the four edits that change it.
 *
 * The whole sidebar is read in a handful of statements rather than a query per
 * level. One person's notes are a few hundred rows at the outside and a team's
 * notebook is not much more, so a single read of the titles costs less than the
 * round trips a recursive walk would take, and the tree is assembled in memory
 * where the ordering rules are one comparison instead of a query each.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import type { NoteActor } from "./access";

/** A folder as the sidebar draws it. */
export interface FolderSummary {
    readonly id: string;
    readonly name: string;
    readonly icon: string | null;
    readonly parentId: string | null;
    readonly order: number;
}

/** A shelf and everything filed on it. The private one has no space. */
export interface ShelfView {
    /** Null on the private shelf, which is not a row and never will be. */
    readonly space: {
        readonly id: string;
        readonly name: string;
        readonly icon: string | null;
        readonly color: string;
        readonly visibility: string;
        readonly orgId: string | null;
        /** What the reader may do here, so the sidebar can hide what would be
         *  refused rather than offer it and fail. */
        readonly role: core.SpaceRole | "owner";
        readonly archived: boolean;
    } | null;
    readonly folders: readonly FolderSummary[];
}

/** What somebody is on a shelf, for the people dialog. */
export interface ShelfPerson {
    readonly userId: string;
    readonly name: string;
    readonly email: string;
    readonly role: core.SpaceRole;
    /** True for the person who made it: shown, and never editable. */
    readonly owner: boolean;
}

export interface ShelfTeam {
    readonly teamId: string;
    readonly name: string;
    readonly role: core.SpaceRole;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * Every shelf this reader can see right now: their own, then the spaces on the
 * workspace they have open.
 *
 * The private shelf is always first and always present, even when it is empty -
 * it is where a new note goes, so a sidebar that hid it would hide the only
 * place somebody can write without being invited anywhere.
 */
export async function listShelves(actor: NoteActor, spaceIds: readonly string[]): Promise<ShelfView[]> {
    const [ownFolders, spaces] = await Promise.all([
        prisma.noteFolder.findMany({
            where: { ownerId: actor.id, spaceId: null, archived: false },
            orderBy: [{ order: "asc" }, { name: "asc" }],
            select: { id: true, name: true, icon: true, parentId: true, order: true }
        }),
        spaceIds.length > 0
            ? prisma.noteSpace.findMany({
                  where: { id: { in: [...spaceIds] }, archived: false },
                  orderBy: [{ order: "asc" }, { name: "asc" }],
                  select: {
                      id: true,
                      name: true,
                      icon: true,
                      color: true,
                      visibility: true,
                      orgId: true,
                      ownerId: true,
                      archived: true,
                      members: { where: { userId: actor.id }, select: { role: true } },
                      teamGrants: {
                          where: { team: { members: { some: { userId: actor.id } } } },
                          select: { role: true }
                      },
                      folders: {
                          where: { archived: false },
                          orderBy: [{ order: "asc" }, { name: "asc" }],
                          select: { id: true, name: true, icon: true, parentId: true, order: true }
                      }
                  }
              })
            : Promise.resolve([])
    ]);

    const shelves: ShelfView[] = [{ space: null, folders: ownFolders }];
    for (const space of spaces) {
        shelves.push({
            space: {
                id: space.id,
                name: space.name,
                icon: space.icon,
                color: space.color,
                visibility: space.visibility,
                orgId: space.orgId,
                archived: space.archived,
                role: roleFrom(actor, space)
            },
            folders: space.folders
        });
    }
    return shelves;
}

/**
 * What the reader holds on a space, from the row the listing already fetched.
 *
 * Deliberately the cheap answer rather than a second `resolveSpaceRole` per
 * shelf: it is used to decide which menu items to draw, and every one of those
 * items is checked properly on the way in. An underestimate hides an action
 * somebody could have taken; it never permits one.
 */
function roleFrom(
    actor: NoteActor,
    space: { ownerId: string; members: { role: string }[]; teamGrants: { role: string }[] }
): core.SpaceRole | "owner" {
    if (space.ownerId === actor.id || actor.isAdmin) return "owner";
    let role: core.SpaceRole | null = (space.members[0]?.role as core.SpaceRole | undefined) ?? null;
    for (const grant of space.teamGrants) {
        const granted = grant.role as core.SpaceRole;
        role = role ? core.strongerRole(role, granted) : granted;
    }
    return role ?? "guest";
}

/** The shelves a note may be moved onto, for the move dialog: the private one,
 *  plus every space the reader may write to. */
export async function writableShelves(
    actor: NoteActor,
    spaceIds: readonly string[]
): Promise<{ id: string | null; name: string }[]> {
    const shelves = await listShelves(actor, spaceIds);
    return shelves
        .filter((shelf) => !shelf.space || core.spaceRoleAtLeast(asRole(shelf.space.role), "member"))
        .map((shelf) => ({ id: shelf.space?.id ?? null, name: shelf.space?.name ?? "My notes" }));
}

function asRole(role: core.SpaceRole | "owner"): core.SpaceRole {
    return role === "owner" ? "admin" : role;
}

// ---------------------------------------------------------------------------
// Spaces
// ---------------------------------------------------------------------------

export async function createSpace(actor: NoteActor, input: core.NoteSpaceCreateInput): Promise<string> {
    const last = await prisma.noteSpace.aggregate({
        where: { ownerId: actor.id },
        _max: { order: true }
    });
    const space = await prisma.noteSpace.create({
        data: {
            ownerId: actor.id,
            orgId: input.orgId,
            name: input.name,
            icon: input.icon ?? null,
            color: input.color,
            visibility: input.visibility,
            order: (last._max.order ?? 0) + core.ORDER_STEP
        },
        select: { id: true }
    });
    return space.id;
}

export async function updateSpace(input: core.NoteSpaceUpdateInput): Promise<void> {
    await prisma.noteSpace.update({
        where: { id: input.spaceId },
        data: {
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.icon !== undefined ? { icon: input.icon } : {}),
            ...(input.color !== undefined ? { color: input.color } : {}),
            ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
            ...(input.archived !== undefined ? { archived: input.archived } : {})
        }
    });
}

/** How much a space holds, so a delete can say it before it happens. */
export async function spaceContents(spaceId: string): Promise<{ notes: number; folders: number }> {
    const [notes, folders] = await Promise.all([
        prisma.note.count({ where: { spaceId } }),
        prisma.noteFolder.count({ where: { spaceId } })
    ]);
    return { notes, folders };
}

/** Deleting a space takes its folders and its notes with it, which is the one
 *  place in notes that is true - a shelf is not an arrangement, it is where the
 *  writing lives. The screen says how much first. */
export async function deleteSpace(spaceId: string): Promise<void> {
    await prisma.noteSpace.delete({ where: { id: spaceId } });
}

// ---------------------------------------------------------------------------
// People and teams on a space
// ---------------------------------------------------------------------------

export async function spacePeople(spaceId: string): Promise<ShelfPerson[]> {
    const space = await prisma.noteSpace.findUnique({
        where: { id: spaceId },
        select: {
            owner: { select: { id: true, name: true, email: true } },
            members: {
                orderBy: { createdAt: "asc" },
                select: { role: true, user: { select: { id: true, name: true, email: true } } }
            }
        }
    });
    if (!space) return [];
    return [
        {
            userId: space.owner.id,
            name: space.owner.name,
            email: space.owner.email,
            role: "admin",
            owner: true
        },
        ...space.members.map((member) => ({
            userId: member.user.id,
            name: member.user.name,
            email: member.user.email,
            role: member.role as core.SpaceRole,
            owner: false
        }))
    ];
}

export async function spaceTeams(spaceId: string): Promise<ShelfTeam[]> {
    const grants = await prisma.noteSpaceTeam.findMany({
        where: { spaceId },
        orderBy: { createdAt: "asc" },
        select: { teamId: true, role: true, team: { select: { name: true } } }
    });
    return grants.map((grant) => ({
        teamId: grant.teamId,
        name: grant.team.name,
        role: grant.role as core.SpaceRole
    }));
}

/** The teams that may be given this space: its organization's, and no others.
 *  A personal shelf has none, which is what hides the section. */
export async function teamsForSpace(spaceId: string): Promise<{ id: string; name: string }[]> {
    const space = await prisma.noteSpace.findUnique({ where: { id: spaceId }, select: { orgId: true } });
    if (!space?.orgId) return [];
    return prisma.team.findMany({
        where: { orgId: space.orgId },
        orderBy: { name: "asc" },
        select: { id: true, name: true }
    });
}

export async function grantPerson(spaceId: string, userId: string, role: core.SpaceRole): Promise<void> {
    await prisma.noteSpaceMember.upsert({
        where: { spaceId_userId: { spaceId, userId } },
        create: { spaceId, userId, role },
        update: { role }
    });
}

export async function revokePerson(spaceId: string, userId: string): Promise<void> {
    await prisma.noteSpaceMember.deleteMany({ where: { spaceId, userId } });
}

export async function grantTeam(spaceId: string, teamId: string, role: core.SpaceRole): Promise<void> {
    await prisma.noteSpaceTeam.upsert({
        where: { spaceId_teamId: { spaceId, teamId } },
        create: { spaceId, teamId, role },
        update: { role }
    });
}

export async function revokeTeam(spaceId: string, teamId: string): Promise<void> {
    await prisma.noteSpaceTeam.deleteMany({ where: { spaceId, teamId } });
}

// ---------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------

export async function createFolder(
    actor: NoteActor,
    input: core.NoteFolderCreateInput
): Promise<string> {
    const last = await prisma.noteFolder.aggregate({
        where: shelfWhere(actor, input.spaceId, input.parentId),
        _max: { order: true }
    });
    const folder = await prisma.noteFolder.create({
        data: {
            ownerId: actor.id,
            spaceId: input.spaceId,
            parentId: input.parentId,
            name: input.name,
            icon: input.icon ?? null,
            order: (last._max.order ?? 0) + core.ORDER_STEP
        },
        select: { id: true }
    });
    return folder.id;
}

export async function updateFolder(input: core.NoteFolderUpdateInput): Promise<void> {
    await prisma.noteFolder.update({
        where: { id: input.folderId },
        data: {
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.icon !== undefined ? { icon: input.icon } : {}),
            ...(input.archived !== undefined ? { archived: input.archived } : {})
        }
    });
}

/**
 * Move a folder, within its shelf or onto another one.
 *
 * The refusals are the ones a shape check cannot make: into itself, into its own
 * subtree, or deeper than folders go. They are measured against what is stored
 * so a second tab cannot make the answer wrong between the check and the write,
 * and the same `folderMoveRefusal` the Tasks tree uses answers them - one rule,
 * so a drag and a menu refuse identically.
 *
 * A folder that changes shelf takes its whole subtree and every note under it,
 * because a folder that arrived somewhere without its contents would be an empty
 * folder next to writing nobody can find.
 */
export async function moveFolder(
    actor: NoteActor,
    input: core.NoteFolderMoveInput
): Promise<string | null> {
    const folder = await prisma.noteFolder.findUnique({
        where: { id: input.folderId },
        select: { spaceId: true }
    });
    if (!folder) return "That folder no longer exists";

    if (input.parentId) {
        const parent = await prisma.noteFolder.findUnique({
            where: { id: input.parentId },
            select: { spaceId: true }
        });
        if (!parent) return "That folder no longer exists";
        if ((parent.spaceId ?? null) !== (input.spaceId ?? null)) {
            return "That folder is on a different notebook";
        }
    }

    // The whole shelf's folders, which is what the depth and cycle rules are
    // measured against.
    const folders = await prisma.noteFolder.findMany({
        where: shelfFolderWhere(actor, folder.spaceId),
        select: { id: true, parentId: true }
    });
    const refusal = core.folderMoveRefusal(folders, input.folderId, input.parentId);
    if (refusal) return refusal;

    const branch = core.folderBranch(folders, input.folderId);
    const last = await prisma.noteFolder.aggregate({
        where: shelfWhere(actor, input.spaceId, input.parentId),
        _max: { order: true }
    });

    await prisma.$transaction([
        prisma.noteFolder.update({
            where: { id: input.folderId },
            data: {
                parentId: input.parentId,
                spaceId: input.spaceId,
                order: (last._max.order ?? 0) + core.ORDER_STEP
            }
        }),
        // Everything under it follows onto the new shelf. Its arrangement inside
        // the branch is untouched - only which shelf it is on changes.
        prisma.noteFolder.updateMany({
            where: { id: { in: [...branch].filter((id) => id !== input.folderId) } },
            data: { spaceId: input.spaceId }
        }),
        prisma.note.updateMany({
            where: { folderId: { in: [...branch] } },
            data: { spaceId: input.spaceId }
        })
    ]);
    return null;
}

/** What a folder holds directly, so a delete can say so before it lifts it. */
export async function folderContents(folderId: string): Promise<{ notes: number; folders: number }> {
    const [notes, folders] = await Promise.all([
        prisma.note.count({ where: { folderId } }),
        prisma.noteFolder.count({ where: { parentId: folderId } })
    ]);
    return { notes, folders };
}

/**
 * Delete a folder and lift what was inside it to the folder's own parent.
 *
 * A folder is an arrangement, not the owner of the writing filed under it. The
 * cascade in the schema would take the subfolders with it, so the lift happens
 * first, in the same transaction: what a person removes is one level of filing,
 * never their notes.
 */
export async function deleteFolder(folderId: string): Promise<void> {
    const folder = await prisma.noteFolder.findUnique({
        where: { id: folderId },
        select: { parentId: true }
    });
    if (!folder) return;
    await prisma.$transaction([
        prisma.noteFolder.updateMany({ where: { parentId: folderId }, data: { parentId: folder.parentId } }),
        prisma.note.updateMany({ where: { folderId }, data: { folderId: folder.parentId } }),
        prisma.noteFolder.delete({ where: { id: folderId } })
    ]);
}

/** Where a new sibling belongs, which differs by shelf: a space's folders are
 *  the space's, and a private one's are the account's own. */
function shelfWhere(actor: NoteActor, spaceId: string | null, parentId: string | null) {
    return spaceId
        ? { spaceId, parentId }
        : { spaceId: null, ownerId: actor.id, parentId };
}

function shelfFolderWhere(actor: NoteActor, spaceId: string | null) {
    return spaceId ? { spaceId } : { spaceId: null, ownerId: actor.id };
}
