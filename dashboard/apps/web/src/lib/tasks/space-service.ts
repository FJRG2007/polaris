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
import type { SpaceAccess } from "./access";

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

export interface FolderSummary {
    readonly id: string;
    readonly name: string;
    readonly lists: ListSummary[];
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
}

/**
 * Everything the left rail draws, for every space the actor can see, in one
 * round trip. Counts come from a single grouped query rather than a count per
 * list, so a workspace with forty lists still costs three statements.
 */
export async function listSpaceTree(
    userId: string,
    spaceIds: string[],
    isAdmin: boolean
): Promise<SpaceTreeView[]> {
    if (spaceIds.length === 0) return [];

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
                    select: { id: true, name: true }
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
        const own = lists.filter((list) => list.spaceId === space.id);
        const role: SpaceAccess =
            space.ownerId === userId || isAdmin ? "owner" : ((space.members[0]?.role as core.SpaceRole) ?? "guest");
        return {
            id: space.id,
            name: space.name,
            prefix: space.prefix,
            color: space.color,
            visibility: space.visibility as core.SpaceVisibility,
            role,
            folders: space.folders.map((folder) => ({
                id: folder.id,
                name: folder.name,
                lists: own.filter((list) => list.folderId === folder.id).map(summarize)
            })),
            lists: own.filter((list) => list.folderId === null).map(summarize)
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

/** The people a picker can offer for a space: its owner and its members. */
export async function spacePeople(spaceId: string): Promise<{ id: string; name: string; image: string | null }[]> {
    const members = await listSpaceMembers(spaceId);
    return members.map((member) => ({ id: member.userId, name: member.name, image: member.image }));
}

// ---------------------------------------------------------------------------
// Folders and lists
// ---------------------------------------------------------------------------

/** The next order key at the end of a set, so a new container lands last. */
async function nextOrder(model: "folder" | "list", spaceId: string): Promise<number> {
    const last =
        model === "folder"
            ? await prisma.taskFolder.findFirst({
                  where: { spaceId },
                  orderBy: { order: "desc" },
                  select: { order: true }
              })
            : await prisma.taskList.findFirst({
                  where: { spaceId },
                  orderBy: { order: "desc" },
                  select: { order: true }
              });
    return (last?.order ?? 0) + core.ORDER_STEP;
}

export async function createFolder(spaceId: string, name: string): Promise<string> {
    const folder = await prisma.taskFolder.create({
        data: { spaceId, name, order: await nextOrder("folder", spaceId) },
        select: { id: true }
    });
    return folder.id;
}

export async function renameFolder(folderId: string, name: string): Promise<void> {
    await prisma.taskFolder.update({ where: { id: folderId }, data: { name } });
}

/** Deleting a folder keeps its lists and returns them to the space root: a
 *  folder is an arrangement, not the owner of the work inside it. */
export async function deleteFolder(folderId: string): Promise<void> {
    await prisma.$transaction([
        prisma.taskList.updateMany({ where: { folderId }, data: { folderId: null } }),
        prisma.taskFolder.delete({ where: { id: folderId } })
    ]);
}

export async function createList(input: core.ListInput): Promise<string> {
    const list = await prisma.taskList.create({
        data: {
            spaceId: input.spaceId,
            folderId: input.folderId,
            name: input.name,
            description: input.description,
            color: input.color ?? null,
            startDate: input.startDate ? new Date(input.startDate) : null,
            dueDate: input.dueDate ? new Date(input.dueDate) : null,
            order: await nextOrder("list", input.spaceId)
        },
        select: { id: true }
    });
    return list.id;
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

export async function createStatus(spaceId: string, name: string, type: core.TaskStatusType, color: string): Promise<void> {
    const last = await prisma.taskStatus.findFirst({
        where: { spaceId },
        orderBy: { order: "desc" },
        select: { order: true }
    });
    await prisma.taskStatus.create({
        data: { spaceId, name, type, color, order: (last?.order ?? 0) + core.ORDER_STEP }
    });
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
