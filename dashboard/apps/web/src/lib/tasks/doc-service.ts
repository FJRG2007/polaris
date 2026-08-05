/**
 * Docs and wikis: the writing that sits next to the work.
 *
 * A page is Markdown in a tree. Storing the source rather than a proprietary
 * block model is deliberate - it means a space's knowledge base can be read,
 * diffed and taken out of Polaris with no export step.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";

export interface DocNode {
    readonly id: string;
    readonly title: string;
    readonly icon: string;
    /** The folder this page belongs to, so the sidebar can say which project a
     *  page is about without opening it. Null for a page the space shares. */
    readonly folderName: string | null;
    readonly children: DocNode[];
}

export interface DocView {
    readonly id: string;
    readonly spaceId: string | null;
    readonly folderId: string | null;
    readonly parentId: string | null;
    readonly title: string;
    readonly icon: string;
    readonly body: string;
    readonly updatedAt: string;
    readonly updatedByName: string | null;
    readonly breadcrumb: { id: string; title: string }[];
}

/**
 * The whole tree for a set of spaces, nested for the sidebar.
 *
 * `folderIds` names the folders reached through a grant rather than through the
 * space above them, so somebody invited to one client's folder reads that
 * client's pages and no others.
 */
export async function docTree(spaceIds: string[], folderIds: string[] = []): Promise<DocNode[]> {
    const docs = await prisma.taskDoc.findMany({
        where: {
            archived: false,
            OR: [{ spaceId: { in: spaceIds } }, { spaceId: null }, { folderId: { in: folderIds } }]
        },
        orderBy: [{ order: "asc" }, { createdAt: "asc" }],
        select: { id: true, title: true, icon: true, parentId: true, folder: { select: { name: true } } }
    });

    const children = new Map<string, DocNode[]>();
    const roots: DocNode[] = [];
    const nodes = new Map(
        docs.map((doc) => [
            doc.id,
            { id: doc.id, title: doc.title, icon: doc.icon, folderName: doc.folder?.name ?? null, children: [] as DocNode[] }
        ])
    );

    for (const doc of docs) {
        const node = nodes.get(doc.id) as DocNode;
        if (doc.parentId && nodes.has(doc.parentId)) {
            const siblings = children.get(doc.parentId) ?? [];
            siblings.push(node);
            children.set(doc.parentId, siblings);
        } else {
            roots.push(node);
        }
    }
    for (const [parentId, list] of children) {
        const parent = nodes.get(parentId);
        if (parent) parent.children.push(...list);
    }
    return roots;
}

export async function getDoc(docId: string): Promise<DocView | null> {
    const doc = await prisma.taskDoc.findUnique({
        where: { id: docId },
        select: {
            id: true,
            spaceId: true,
            folderId: true,
            parentId: true,
            title: true,
            icon: true,
            body: true,
            updatedAt: true,
            updatedById: true
        }
    });
    if (!doc) return null;

    // Walk up to the root so the reader always knows where a page sits. Bounded
    // rather than recursive: a tree deeper than this is a loop somebody made.
    const breadcrumb: { id: string; title: string }[] = [];
    let parentId = doc.parentId;
    for (let depth = 0; depth < 10 && parentId; depth += 1) {
        const parent: { id: string; title: string; parentId: string | null } | null = await prisma.taskDoc.findUnique({
            where: { id: parentId },
            select: { id: true, title: true, parentId: true }
        });
        if (!parent) break;
        breadcrumb.unshift({ id: parent.id, title: parent.title });
        parentId = parent.parentId;
    }

    const author = doc.updatedById
        ? await prisma.user.findUnique({ where: { id: doc.updatedById }, select: { name: true } })
        : null;

    return {
        id: doc.id,
        spaceId: doc.spaceId,
        folderId: doc.folderId,
        parentId: doc.parentId,
        title: doc.title,
        icon: doc.icon,
        body: doc.body,
        updatedAt: doc.updatedAt.toISOString(),
        updatedByName: author?.name ?? null,
        breadcrumb
    };
}

export async function createDoc(actorId: string, input: core.DocInput): Promise<string> {
    const last = await prisma.taskDoc.findFirst({
        where: { spaceId: input.spaceId, folderId: input.folderId, parentId: input.parentId },
        orderBy: { order: "desc" },
        select: { order: true }
    });
    const doc = await prisma.taskDoc.create({
        data: {
            spaceId: input.spaceId,
            folderId: input.folderId,
            parentId: input.parentId,
            title: input.title,
            body: input.body,
            icon: input.icon,
            order: (last?.order ?? 0) + core.ORDER_STEP,
            createdById: actorId,
            updatedById: actorId
        },
        select: { id: true }
    });
    return doc.id;
}

export async function updateDoc(actorId: string, docId: string, input: core.DocInput): Promise<void> {
    await prisma.taskDoc.update({
        where: { id: docId },
        data: {
            title: input.title,
            body: input.body,
            icon: input.icon,
            folderId: input.folderId,
            parentId: input.parentId,
            updatedById: actorId
        }
    });
}

/** Where a page sits, so an action handed only its id can authorize the write
 *  against the same folder or space the page was created under. A page with
 *  neither belongs to whoever wrote it. */
export async function docOwner(
    docId: string
): Promise<{ spaceId: string | null; folderId: string | null; createdById: string | null } | null> {
    return prisma.taskDoc.findUnique({
        where: { id: docId },
        select: { spaceId: true, folderId: true, createdById: true }
    });
}

export async function deleteDoc(docId: string): Promise<void> {
    await prisma.taskDoc.delete({ where: { id: docId } });
}
