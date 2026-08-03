/**
 * The containers: spaces, folders, lists, and the vocabulary a space shares
 * across them (statuses, tags, custom fields, members).
 *
 * Authorization is the caller's job (see access.ts). What this module owns is
 * keeping the containers coherent: a new space is never empty, a status is never
 * deleted out from under the tasks holding it, and a reference prefix is never
 * handed to two spaces.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import type { SpaceAccess, TaskScope } from "./access";

// ---------------------------------------------------------------------------
// The sidebar tree
// ---------------------------------------------------------------------------

export interface ListSummary {
    readonly id: string;
    readonly name: string;
    readonly folderId: string | null;
    readonly color: string | null;
    readonly openCount: number;
    readonly totalCount: number;
}

/** Folders come back flat with their parent, and the sidebar nests them through
 *  the same `buildFolderTree` the server would use. Sending the nesting already
 *  built would mean two shapes of the same tree to keep in step. */
export interface FolderSummary {
    readonly id: string;
    readonly name: string;
    readonly parentId: string | null;
    readonly lists: ListSummary[];
    /** What the reader may do in this branch. Equal to the space role except in
     *  a space they only reach through a grant, where each branch can differ. */
    readonly role: SpaceAccess;
}

export interface SpaceTreeView {
    readonly id: string;
    readonly name: string;
    readonly prefix: string;
    readonly color: string;
    readonly visibility: core.SpaceVisibility;
    readonly role: SpaceAccess;
    readonly folders: FolderSummary[];
    /** Lists that sit at the space root rather than in a folder. */
    readonly lists: ListSummary[];
    /** True when the actor only reaches part of this space through a folder
     *  grant, so the sidebar can hide the space-wide controls. */
    readonly partial: boolean;
}

/**
 * Everything the left rail draws, for every space the actor can see, in one
 * round trip. Counts come from a single grouped query rather than a count per
 * list, so a workspace with forty lists still costs three statements.
 *
 * A space the actor only reaches through a folder grant is pruned to that
 * branch: the folders outside it and the lists at the space root never leave the
 * server, so the sidebar cannot show a client the client beside them.
 */
export async function listSpaceTree(userId: string, scope: TaskScope, isAdmin: boolean): Promise<SpaceTreeView[]> {
    const spaceIds = [...scope.spaceIds, ...scope.partialSpaceIds];
    if (spaceIds.length === 0) return [];

    const partialSpaces = new Set(scope.partialSpaceIds);
    const grantedListIds = new Set(scope.listIds);

    const [spaces, lists, counts] = await Promise.all([
        prisma.taskSpace.findMany({
            where: { id: { in: spaceIds } },
            orderBy: [{ order: "asc" }, { createdAt: "asc" }],
            select: {
                id: true,
                name: true,
                prefix: true,
                color: true,
                visibility: true,
                ownerId: true,
                members: { where: { userId }, select: { role: true } },
                folders: {
                    where: { archived: false },
                    orderBy: [{ order: "asc" }, { createdAt: "asc" }],
                    select: { id: true, name: true, parentId: true }
                }
            }
        }),
        prisma.taskList.findMany({
            where: { spaceId: { in: spaceIds }, archived: false },
            orderBy: [{ order: "asc" }, { createdAt: "asc" }],
            select: { id: true, spaceId: true, folderId: true, name: true, color: true }
        }),
        prisma.task.groupBy({
            by: ["listId", "statusId"],
            where: { spaceId: { in: spaceIds }, archived: false, parentId: null },
            _count: { _all: true }
        })
    ]);

    const finishedStatusIds = await finishedStatuses(spaceIds);
    const totals = new Map<string, { open: number; total: number }>();
    for (const row of counts) {
        const bucket = totals.get(row.listId) ?? { open: 0, total: 0 };
        bucket.total += row._count._all;
        if (!row.statusId || !finishedStatusIds.has(row.statusId)) bucket.open += row._count._all;
        totals.set(row.listId, bucket);
    }

    const summarize = (list: (typeof lists)[number]): ListSummary => {
        const bucket = totals.get(list.id);
        return {
            id: list.id,
            name: list.name,
            folderId: list.folderId,
            color: list.color,
            openCount: bucket?.open ?? 0,
            totalCount: bucket?.total ?? 0
        };
    };

    return spaces.map((space) => {
        const partial = partialSpaces.has(space.id);
        const folders = partial
            ? space.folders.filter((folder) => scope.folderRoles[folder.id] !== undefined)
            : space.folders;
        const own = lists
            .filter((list) => list.spaceId === space.id)
            .filter((list) => !partial || grantedListIds.has(list.id));
        const spaceRole: SpaceAccess =
            space.ownerId === userId || isAdmin ? "owner" : ((space.members[0]?.role as core.SpaceRole) ?? "guest");
        // In a partial space the space role means nothing - what the reader may
        // do is whatever their strongest grant gives them.
        const role: SpaceAccess = partial
            ? folders.reduce<core.SpaceRole>(
                  (best, folder) => core.strongerRole(best, scope.folderRoles[folder.id] as core.SpaceRole),
                  "guest"
              )
            : spaceRole;
        return {
            id: space.id,
            name: space.name,
            prefix: space.prefix,
            color: space.color,
            visibility: space.visibility as core.SpaceVisibility,
            role,
            folders: folders.map((folder) => ({
                id: folder.id,
                name: folder.name,
                // A granted branch's top folder keeps its real parent id, which
                // no longer resolves in the pruned set. buildFolderTree treats a
                // missing parent as a root, so the branch draws from its top.
                parentId: folder.parentId,
                lists: own.filter((list) => list.folderId === folder.id).map(summarize),
                role: partial ? (scope.folderRoles[folder.id] as core.SpaceRole) : spaceRole
            })),
            lists: partial ? [] : own.filter((list) => list.folderId === null).map(summarize),
            partial
        };
    });
}

/** The status ids that mean "finished" across a set of spaces. */
export async function finishedStatuses(spaceIds: string[]): Promise<Set<string>> {
    const statuses = await prisma.taskStatus.findMany({
        where: { spaceId: { in: spaceIds }, type: { in: ["done", "closed"] } },
        select: { id: true }
    });
    return new Set(statuses.map((status) => status.id));
}

// ---------------------------------------------------------------------------
// Spaces
// ---------------------------------------------------------------------------

/**
 * A prefix nobody else holds. The derived one wins when it is free; otherwise a
 * digit is appended, because "ENG2" still reads as engineering while a random
 * suffix does not.
 */
async function uniquePrefix(name: string): Promise<string> {
    const base = core.deriveSpacePrefix(name);
    for (let attempt = 0; attempt < 100; attempt += 1) {
        const candidate = attempt === 0 ? base : `${base}${attempt + 1}`;
        const taken = await prisma.taskSpace.findUnique({ where: { prefix: candidate }, select: { id: true } });
        if (!taken) return candidate;
    }
    // A hundred spaces sharing a derived prefix is not a real workspace, but a
    // collision must never be a crash.
    return `${base}${Date.now().toString(36).slice(-4).toUpperCase()}`;
}

/**
 * Create a space that is usable the moment it exists: the default statuses, one
 * list, and a saved board view. An empty space with no workflow is a dead end
 * that every user then has to assemble by hand.
 */
export async function createSpace(
    ownerId: string,
    input: core.SpaceInput
): Promise<{ id: string; listId: string }> {
    const prefix = await uniquePrefix(input.name);
    const last = await prisma.taskSpace.findFirst({ orderBy: { order: "desc" }, select: { order: true } });

    return prisma.$transaction(async (tx) => {
        const space = await tx.taskSpace.create({
            data: {
                ownerId,
                name: input.name,
                prefix,
                description: input.description,
                color: input.color,
                visibility: input.visibility,
                order: (last?.order ?? 0) + core.ORDER_STEP
            },
            select: { id: true }
        });

        await tx.taskStatus.createMany({
            data: core.DEFAULT_TASK_STATUSES.map((status, index) => ({
                spaceId: space.id,
                name: status.name,
                type: status.type,
                color: status.color,
                order: (index + 1) * core.ORDER_STEP
            }))
        });

        const list = await tx.taskList.create({
            data: { spaceId: space.id, name: "Tasks", order: core.ORDER_STEP },
            select: { id: true }
        });

        await tx.taskView.create({
            data: {
                ownerId,
                listId: list.id,
                name: "Board",
                type: "board",
                groupBy: "status",
                filter: JSON.stringify(core.EMPTY_FILTER)
            }
        });

        return { id: space.id, listId: list.id };
    });
}

export async function renameSpace(spaceId: string, name: string): Promise<void> {
    await prisma.taskSpace.update({ where: { id: spaceId }, data: { name } });
}

export async function updateSpace(spaceId: string, input: core.SpaceInput): Promise<void> {
    await prisma.taskSpace.update({
        where: { id: spaceId },
        data: {
            name: input.name,
            description: input.description,
            color: input.color,
            visibility: input.visibility
        }
    });
}

export async function setSpaceArchived(spaceId: string, archived: boolean): Promise<void> {
    await prisma.taskSpace.update({ where: { id: spaceId }, data: { archived } });
}

export async function deleteSpace(spaceId: string): Promise<void> {
    await prisma.taskSpace.delete({ where: { id: spaceId } });
}

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

export interface SpaceMemberView {
    readonly userId: string;
    readonly name: string;
    readonly email: string;
    readonly image: string | null;
    readonly role: core.SpaceRole | "owner";
}

export async function listSpaceMembers(spaceId: string): Promise<SpaceMemberView[]> {
    const space = await prisma.taskSpace.findUnique({
        where: { id: spaceId },
        select: {
            owner: { select: { id: true, name: true, email: true, image: true } },
            members: {
                orderBy: { createdAt: "asc" },
                select: { role: true, user: { select: { id: true, name: true, email: true, image: true } } }
            }
        }
    });
    if (!space) return [];
    return [
        {
            userId: space.owner.id,
            name: space.owner.name,
            email: space.owner.email,
            image: space.owner.image,
            role: "owner" as const
        },
        ...space.members.map((member) => ({
            userId: member.user.id,
            name: member.user.name,
            email: member.user.email,
            image: member.user.image,
            role: member.role as core.SpaceRole
        }))
    ];
}

/** Add somebody by email or username, which is what the operator has in front
 *  of them rather than an id. */
export async function addSpaceMember(spaceId: string, identifier: string, role: core.SpaceRole): Promise<void> {
    const needle = identifier.trim().toLowerCase();
    const user = await prisma.user.findFirst({
        where: { OR: [{ email: needle }, { username: needle }] },
        select: { id: true }
    });
    if (!user) throw new Error("No account matches that email or username");

    const space = await prisma.taskSpace.findUnique({ where: { id: spaceId }, select: { ownerId: true } });
    if (space?.ownerId === user.id) throw new Error("That person already owns this space");

    await prisma.taskSpaceMember.upsert({
        where: { spaceId_userId: { spaceId, userId: user.id } },
        update: { role },
        create: { spaceId, userId: user.id, role }
    });
}

export async function setSpaceMemberRole(spaceId: string, userId: string, role: core.SpaceRole): Promise<void> {
    await prisma.taskSpaceMember.update({ where: { spaceId_userId: { spaceId, userId } }, data: { role } });
}

export async function removeSpaceMember(spaceId: string, userId: string): Promise<void> {
    await prisma.taskSpaceMember.deleteMany({ where: { spaceId, userId } });
}

/** The people a picker can offer for a space: its owner, its members, and anyone
 *  invited to a folder inside it - a task in a client's folder has to be
 *  assignable to that client. */
export async function spacePeople(spaceId: string): Promise<{ id: string; name: string; image: string | null }[]> {
    const [members, grantees] = await Promise.all([
        listSpaceMembers(spaceId),
        prisma.taskFolderMember.findMany({
            where: { folder: { spaceId } },
            select: { user: { select: { id: true, name: true, image: true } } }
        })
    ]);
    const people = new Map(members.map((member) => [member.userId, { id: member.userId, name: member.name, image: member.image }]));
    for (const grant of grantees) {
        if (!people.has(grant.user.id)) people.set(grant.user.id, grant.user);
    }
    return [...people.values()];
}

// ---------------------------------------------------------------------------
// Folder members
// ---------------------------------------------------------------------------

export interface FolderMemberView {
    readonly userId: string;
    readonly name: string;
    readonly email: string;
    readonly image: string | null;
    readonly role: core.SpaceRole;
    /** The folder the grant was actually made on. Equal to the folder being
     *  looked at, or an ancestor when the access is inherited. */
    readonly folderId: string;
    readonly folderName: string;
    readonly inherited: boolean;
}

export interface FolderDetail {
    readonly id: string;
    readonly spaceId: string;
    readonly parentId: string | null;
    readonly name: string;
    /** Root first, this folder last, for a breadcrumb. */
    readonly path: { id: string; name: string }[];
}

export async function getFolder(folderId: string): Promise<FolderDetail | null> {
    const folder = await prisma.taskFolder.findUnique({
        where: { id: folderId },
        select: { id: true, spaceId: true, parentId: true, name: true }
    });
    if (!folder) return null;
    const folders = await prisma.taskFolder.findMany({
        where: { spaceId: folder.spaceId },
        select: { id: true, parentId: true, name: true }
    });
    return {
        id: folder.id,
        spaceId: folder.spaceId,
        parentId: folder.parentId,
        name: folder.name,
        path: core.folderAncestors(folders, folderId).map((entry) => ({ id: entry.id, name: entry.name }))
    };
}

/**
 * Who reaches this folder through a grant - the ones made on it, and the ones
 * made further up that it inherits. Showing the inherited rows is the point:
 * without them somebody reads an empty list and re-invites a person who is
 * already there through the client above.
 */
export async function listFolderMembers(folderId: string): Promise<FolderMemberView[]> {
    const folder = await prisma.taskFolder.findUnique({ where: { id: folderId }, select: { spaceId: true } });
    if (!folder) return [];
    const folders = await prisma.taskFolder.findMany({
        where: { spaceId: folder.spaceId },
        select: { id: true, parentId: true, name: true }
    });
    const chain = core.folderAncestors(folders, folderId);
    const grants = await prisma.taskFolderMember.findMany({
        where: { folderId: { in: chain.map((entry) => entry.id) } },
        orderBy: { createdAt: "asc" },
        select: {
            folderId: true,
            role: true,
            user: { select: { id: true, name: true, email: true, image: true } }
        }
    });
    const names = new Map(chain.map((entry) => [entry.id, entry.name]));
    return grants.map((grant) => ({
        userId: grant.user.id,
        name: grant.user.name,
        email: grant.user.email,
        image: grant.user.image,
        role: grant.role as core.SpaceRole,
        folderId: grant.folderId,
        folderName: names.get(grant.folderId) ?? "",
        inherited: grant.folderId !== folderId
    }));
}

/** Invite somebody to one branch by email or username, which is what the person
 *  doing the inviting has in front of them rather than an id. */
export async function addFolderMember(folderId: string, identifier: string, role: core.SpaceRole): Promise<void> {
    const needle = identifier.trim().toLowerCase();
    const user = await prisma.user.findFirst({
        where: { OR: [{ email: needle }, { username: needle }] },
        select: { id: true }
    });
    if (!user) throw new Error("No account matches that email or username");

    const folder = await prisma.taskFolder.findUnique({
        where: { id: folderId },
        select: { space: { select: { ownerId: true } } }
    });
    if (folder?.space.ownerId === user.id) throw new Error("That person already owns this space");

    await prisma.taskFolderMember.upsert({
        where: { folderId_userId: { folderId, userId: user.id } },
        update: { role },
        create: { folderId, userId: user.id, role }
    });
}

export async function setFolderMemberRole(folderId: string, userId: string, role: core.SpaceRole): Promise<void> {
    await prisma.taskFolderMember.update({ where: { folderId_userId: { folderId, userId } }, data: { role } });
}

export async function removeFolderMember(folderId: string, userId: string): Promise<void> {
    await prisma.taskFolderMember.deleteMany({ where: { folderId, userId } });
}

// ---------------------------------------------------------------------------
// Folders and lists
// ---------------------------------------------------------------------------

/** The next order key at the end of a container, so a new folder or list lands
 *  last among its own siblings rather than last in the whole space. */
async function nextOrder(model: "folder" | "list", spaceId: string, parentId: string | null): Promise<number> {
    const last =
        model === "folder"
            ? await prisma.taskFolder.findFirst({
                  where: { spaceId, parentId },
                  orderBy: { order: "desc" },
                  select: { order: true }
              })
            : await prisma.taskList.findFirst({
                  where: { spaceId, folderId: parentId },
                  orderBy: { order: "desc" },
                  select: { order: true }
              });
    return (last?.order ?? 0) + core.ORDER_STEP;
}

/**
 * The order key for a container dropped between two neighbours, re-spacing the
 * siblings first when the gap has become too thin to split honestly. Returns
 * null when a neighbour named by the client has since disappeared, so the caller
 * refuses the drop rather than writing an order derived from nothing.
 */
async function orderForDrop(
    model: "folder" | "list",
    spaceId: string,
    parentId: string | null,
    move: core.ContainerMove
): Promise<number | null> {
    const read = async (id: string): Promise<number | null> => {
        const row =
            model === "folder"
                ? await prisma.taskFolder.findUnique({ where: { id }, select: { order: true } })
                : await prisma.taskList.findUnique({ where: { id }, select: { order: true } });
        return row?.order ?? null;
    };

    const before = move.beforeId ? await read(move.beforeId) : null;
    const after = move.afterId ? await read(move.afterId) : null;
    if ((move.beforeId && before === null) || (move.afterId && after === null)) return null;

    if (!core.needsRebalance(before, after)) {
        return before === null && after === null
            ? await nextOrder(model, spaceId, parentId)
            : core.orderBetween(before, after);
    }

    // Too tight to split: re-space the whole container, then read the two
    // neighbours again so the drop lands in the gap that now exists.
    await rebalanceContainer(model, spaceId, parentId);
    const spacedBefore = move.beforeId ? await read(move.beforeId) : null;
    const spacedAfter = move.afterId ? await read(move.afterId) : null;
    return core.orderBetween(spacedBefore, spacedAfter);
}

/** Evenly re-space one container's children after their gaps have collapsed. */
async function rebalanceContainer(model: "folder" | "list", spaceId: string, parentId: string | null): Promise<void> {
    const siblings =
        model === "folder"
            ? await prisma.taskFolder.findMany({
                  where: { spaceId, parentId },
                  orderBy: [{ order: "asc" }, { createdAt: "asc" }],
                  select: { id: true }
              })
            : await prisma.taskList.findMany({
                  where: { spaceId, folderId: parentId },
                  orderBy: [{ order: "asc" }, { createdAt: "asc" }],
                  select: { id: true }
              });
    const orders = core.rebalanceOrders(siblings.length);
    await prisma.$transaction(
        siblings.map((row, index) =>
            model === "folder"
                ? prisma.taskFolder.update({ where: { id: row.id }, data: { order: orders[index] } })
                : prisma.taskList.update({ where: { id: row.id }, data: { order: orders[index] } })
        )
    );
}

export async function createFolder(input: core.FolderInput): Promise<string> {
    if (input.parentId) {
        const parent = await prisma.taskFolder.findUnique({
            where: { id: input.parentId },
            select: { spaceId: true }
        });
        if (!parent || parent.spaceId !== input.spaceId) throw new Error("That folder is not in this space");
        const folders = await spaceFolders(input.spaceId);
        if (core.folderDepth(folders, input.parentId) + 1 >= core.FOLDER_DEPTH_LIMIT) {
            throw new Error(`Folders can nest ${core.FOLDER_DEPTH_LIMIT} deep`);
        }
    }
    const folder = await prisma.taskFolder.create({
        data: {
            spaceId: input.spaceId,
            parentId: input.parentId,
            name: input.name,
            order: await nextOrder("folder", input.spaceId, input.parentId)
        },
        select: { id: true }
    });
    return folder.id;
}

export async function renameFolder(folderId: string, name: string): Promise<void> {
    await prisma.taskFolder.update({ where: { id: folderId }, data: { name } });
}

/** Every folder in a space, as the tree maths wants them. */
async function spaceFolders(spaceId: string): Promise<{ id: string; parentId: string | null }[]> {
    return prisma.taskFolder.findMany({ where: { spaceId }, select: { id: true, parentId: true } });
}

/**
 * Move a folder to a new parent, a new position among its siblings, or both.
 * The refusals live in the engine so a drag can grey out an illegal drop with
 * the same rule that rejects it here.
 */
export async function moveFolder(spaceId: string, folderId: string, move: core.ContainerMove): Promise<void> {
    const folders = await spaceFolders(spaceId);
    if (move.parentId && !folders.some((folder) => folder.id === move.parentId)) {
        throw new Error("That folder is not in this space");
    }
    const refusal = core.folderMoveRefusal(folders, folderId, move.parentId);
    if (refusal) throw new Error(refusal);

    const order = await orderForDrop("folder", spaceId, move.parentId, move);
    if (order === null) throw new Error("That spot has moved. Try again.");
    await prisma.taskFolder.update({ where: { id: folderId }, data: { parentId: move.parentId, order } });
}

/** Move a list into a folder (or back to the space root) and position it. */
export async function moveList(spaceId: string, listId: string, move: core.ContainerMove): Promise<void> {
    if (move.parentId) {
        const parent = await prisma.taskFolder.findUnique({ where: { id: move.parentId }, select: { spaceId: true } });
        if (!parent || parent.spaceId !== spaceId) throw new Error("That folder is not in this space");
    }
    const order = await orderForDrop("list", spaceId, move.parentId, move);
    if (order === null) throw new Error("That spot has moved. Try again.");
    await prisma.taskList.update({ where: { id: listId }, data: { folderId: move.parentId, order } });
}

/**
 * Deleting a folder keeps everything that was inside it and lifts it one level,
 * to the deleted folder's own parent. A folder is an arrangement, not the owner
 * of the work inside it, and the alternative - the database cascade - would take
 * a client's whole project tree down with a mis-click on the client.
 */
export async function deleteFolder(folderId: string): Promise<void> {
    const folder = await prisma.taskFolder.findUnique({ where: { id: folderId }, select: { parentId: true } });
    if (!folder) return;
    await prisma.$transaction([
        prisma.taskFolder.updateMany({ where: { parentId: folderId }, data: { parentId: folder.parentId } }),
        prisma.taskList.updateMany({ where: { folderId }, data: { folderId: folder.parentId } }),
        // Pages and sprints move up with everything else. The database clears
        // the link on its own, which would quietly promote a client's page to
        // the whole space; lifting it explicitly keeps it where it belongs.
        prisma.taskDoc.updateMany({ where: { folderId }, data: { folderId: folder.parentId } }),
        prisma.taskSprint.updateMany({ where: { folderId }, data: { folderId: folder.parentId } }),
        prisma.taskFolder.delete({ where: { id: folderId } })
    ]);
}

/** Everything a create dialog opened from the sidebar needs: the vocabulary of
 *  one space, and the lists a new task could go into. */
export interface CreateContext {
    readonly spaceId: string;
    readonly statuses: StatusView[];
    readonly tags: TagView[];
    readonly people: { id: string; name: string; image: string | null }[];
    readonly lists: { id: string; name: string }[];
}

/**
 * The lists inside a folder, including the ones in the folders under it, so a
 * task created from a project folder can be dropped into any list that project
 * holds. A null folder means the whole space.
 */
export async function branchLists(spaceId: string, folderId: string | null): Promise<{ id: string; name: string }[]> {
    if (!folderId) {
        return prisma.taskList.findMany({
            where: { spaceId, archived: false },
            orderBy: [{ order: "asc" }, { createdAt: "asc" }],
            select: { id: true, name: true }
        });
    }
    const branch = core.folderBranch(await spaceFolders(spaceId), folderId);
    return prisma.taskList.findMany({
        where: { spaceId, archived: false, folderId: { in: [...branch] } },
        orderBy: [{ order: "asc" }, { createdAt: "asc" }],
        select: { id: true, name: true }
    });
}

export async function createList(input: core.ListInput): Promise<string> {
    if (input.folderId) {
        const parent = await prisma.taskFolder.findUnique({ where: { id: input.folderId }, select: { spaceId: true } });
        if (!parent || parent.spaceId !== input.spaceId) throw new Error("That folder is not in this space");
    }
    const list = await prisma.taskList.create({
        data: {
            spaceId: input.spaceId,
            folderId: input.folderId,
            name: input.name,
            description: input.description,
            color: input.color ?? null,
            startDate: input.startDate ? new Date(input.startDate) : null,
            dueDate: input.dueDate ? new Date(input.dueDate) : null,
            order: await nextOrder("list", input.spaceId, input.folderId)
        },
        select: { id: true }
    });
    return list.id;
}

export async function renameList(listId: string, name: string): Promise<void> {
    await prisma.taskList.update({ where: { id: listId }, data: { name } });
}

export async function updateList(listId: string, input: Omit<core.ListInput, "spaceId">): Promise<void> {
    await prisma.taskList.update({
        where: { id: listId },
        data: {
            folderId: input.folderId,
            name: input.name,
            description: input.description,
            color: input.color ?? null,
            startDate: input.startDate ? new Date(input.startDate) : null,
            dueDate: input.dueDate ? new Date(input.dueDate) : null
        }
    });
}

export async function deleteList(listId: string): Promise<void> {
    await prisma.taskList.delete({ where: { id: listId } });
}

export interface ListDetail {
    readonly id: string;
    readonly spaceId: string;
    readonly spaceName: string;
    readonly spacePrefix: string;
    readonly folderId: string | null;
    readonly folderName: string | null;
    readonly name: string;
    readonly description: string;
    readonly color: string | null;
    readonly startDate: string | null;
    readonly dueDate: string | null;
}

export async function getList(listId: string): Promise<ListDetail | null> {
    const list = await prisma.taskList.findUnique({
        where: { id: listId },
        select: {
            id: true,
            spaceId: true,
            folderId: true,
            name: true,
            description: true,
            color: true,
            startDate: true,
            dueDate: true,
            space: { select: { name: true, prefix: true } },
            folder: { select: { name: true } }
        }
    });
    if (!list) return null;
    return {
        id: list.id,
        spaceId: list.spaceId,
        spaceName: list.space.name,
        spacePrefix: list.space.prefix,
        folderId: list.folderId,
        folderName: list.folder?.name ?? null,
        name: list.name,
        description: list.description,
        color: list.color,
        startDate: list.startDate?.toISOString() ?? null,
        dueDate: list.dueDate?.toISOString() ?? null
    };
}

// ---------------------------------------------------------------------------
// Statuses
// ---------------------------------------------------------------------------

export interface StatusView {
    readonly id: string;
    readonly name: string;
    readonly type: core.TaskStatusType;
    readonly color: string;
    readonly order: number;
}

export async function listStatuses(spaceId: string): Promise<StatusView[]> {
    const statuses = await prisma.taskStatus.findMany({
        where: { spaceId },
        orderBy: [{ order: "asc" }, { createdAt: "asc" }]
    });
    return statuses.map((status) => ({
        id: status.id,
        name: status.name,
        type: status.type as core.TaskStatusType,
        color: status.color,
        order: status.order
    }));
}

/** Add a status to a space, and say which one it is: a status created from a
 *  task's own menu is meant to be put on that task straight away. */
export async function createStatus(
    spaceId: string,
    name: string,
    type: core.TaskStatusType,
    color: string
): Promise<string> {
    const last = await prisma.taskStatus.findFirst({
        where: { spaceId },
        orderBy: { order: "desc" },
        select: { order: true }
    });
    const status = await prisma.taskStatus.create({
        data: { spaceId, name, type, color, order: (last?.order ?? 0) + core.ORDER_STEP },
        select: { id: true }
    });
    return status.id;
}

export async function updateStatus(
    statusId: string,
    input: { name: string; type: core.TaskStatusType; color: string }
): Promise<void> {
    await prisma.taskStatus.update({ where: { id: statusId }, data: input });
}

/**
 * Delete a status, moving whatever held it onto another one. A status cannot
 * simply vanish: the tasks on it would be left with no column to appear in, and
 * a board that silently drops work is worse than one that refuses the delete.
 */
export async function deleteStatus(spaceId: string, statusId: string, replacementId: string): Promise<void> {
    if (statusId === replacementId) throw new Error("Pick a different status to move the tasks to");
    const remaining = await prisma.taskStatus.count({ where: { spaceId } });
    if (remaining <= 1) throw new Error("A space needs at least one status");
    await prisma.$transaction([
        prisma.task.updateMany({ where: { statusId }, data: { statusId: replacementId } }),
        prisma.taskStatus.delete({ where: { id: statusId } })
    ]);
}

/** Re-space a whole column set after a drag, in the order given. */
export async function reorderStatuses(spaceId: string, orderedIds: string[]): Promise<void> {
    const orders = core.rebalanceOrders(orderedIds.length);
    await prisma.$transaction(
        orderedIds.map((id, index) =>
            prisma.taskStatus.updateMany({ where: { id, spaceId }, data: { order: orders[index] } })
        )
    );
}

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

export interface TagView {
    readonly id: string;
    readonly name: string;
    readonly color: string;
}

export async function listTags(spaceId: string): Promise<TagView[]> {
    return prisma.taskTag.findMany({
        where: { spaceId },
        orderBy: { name: "asc" },
        select: { id: true, name: true, color: true }
    });
}

export async function createTag(spaceId: string, name: string, color: string): Promise<string> {
    const existing = await prisma.taskTag.findUnique({
        where: { spaceId_name: { spaceId, name } },
        select: { id: true }
    });
    if (existing) return existing.id;
    const tag = await prisma.taskTag.create({ data: { spaceId, name, color }, select: { id: true } });
    return tag.id;
}

export async function updateTag(tagId: string, name: string, color: string): Promise<void> {
    await prisma.taskTag.update({ where: { id: tagId }, data: { name, color } });
}

export async function deleteTag(tagId: string): Promise<void> {
    await prisma.taskTag.delete({ where: { id: tagId } });
}

// ---------------------------------------------------------------------------
// Custom fields
// ---------------------------------------------------------------------------

export interface CustomFieldView {
    readonly id: string;
    readonly name: string;
    readonly type: core.CustomFieldType;
    readonly config: core.CustomFieldConfig;
    readonly required: boolean;
    readonly showOnCard: boolean;
}

/** Read a stored field config, falling back to empty so a corrupt row still
 *  renders as a plain field instead of erroring the page. */
function readConfig(raw: string): core.CustomFieldConfig {
    try {
        const parsed = core.customFieldConfigSchema.safeParse(JSON.parse(raw));
        return parsed.success ? parsed.data : {};
    } catch {
        return {};
    }
}

export async function listCustomFields(spaceId: string): Promise<CustomFieldView[]> {
    const fields = await prisma.taskCustomField.findMany({
        where: { spaceId },
        orderBy: [{ order: "asc" }, { createdAt: "asc" }]
    });
    return fields.map((field) => ({
        id: field.id,
        name: field.name,
        type: field.type as core.CustomFieldType,
        config: readConfig(field.config),
        required: field.required,
        showOnCard: field.showOnCard
    }));
}

export async function createCustomField(input: core.CustomFieldInput): Promise<void> {
    const last = await prisma.taskCustomField.findFirst({
        where: { spaceId: input.spaceId },
        orderBy: { order: "desc" },
        select: { order: true }
    });
    await prisma.taskCustomField.create({
        data: {
            spaceId: input.spaceId,
            name: input.name,
            type: input.type,
            config: JSON.stringify(input.config),
            required: input.required,
            showOnCard: input.showOnCard,
            order: (last?.order ?? 0) + core.ORDER_STEP
        }
    });
}

export async function updateCustomField(fieldId: string, input: Omit<core.CustomFieldInput, "spaceId">): Promise<void> {
    await prisma.taskCustomField.update({
        where: { id: fieldId },
        data: {
            name: input.name,
            type: input.type,
            config: JSON.stringify(input.config),
            required: input.required,
            showOnCard: input.showOnCard
        }
    });
}

export async function deleteCustomField(fieldId: string): Promise<void> {
    await prisma.taskCustomField.delete({ where: { id: fieldId } });
}
