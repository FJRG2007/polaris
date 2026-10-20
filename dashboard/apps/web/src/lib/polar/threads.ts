/**
 * Polar's conversations. Every query names the owner, so a thread id from
 * somebody else's browser reads as a thread that does not exist.
 *
 * Messages are stored in the AI SDK's UI message shape, one row each; `parentId`
 * links a message to the one it follows, so an edited message is a sibling of
 * the one it replaced and both versions are kept.
 *
 * Server-only.
 */

import type { UIMessage } from "ai";
import { prisma, Prisma } from "@polaris/db";
import {
    discardPolarAttachments,
    linkPolarAttachments,
    threadAttachments
} from "@/lib/polar/attachments";
import {
    POLAR_SEARCH_PAGE,
    POLAR_THREAD_PAGE,
    queueSchema,
    type ModelChoice,
    type PolarProjectRow,
    type PolarThreadRow,
    type QueuedMessage,
    type ThreadView
} from "@/lib/polar/shared";

export type { PolarThreadRow } from "@/lib/polar/shared";

const ROW_SELECT = {
    id: true,
    title: true,
    updatedAt: true,
    pinnedAt: true,
    archivedAt: true,
    projectId: true
} as const;

type StoredRow = {
    id: string;
    title: string;
    updatedAt: Date;
    pinnedAt: Date | null;
    archivedAt: Date | null;
    projectId: string | null;
};

function toRow(row: StoredRow): PolarThreadRow {
    return {
        id: row.id,
        title: row.title,
        updatedAt: row.updatedAt.toISOString(),
        pinnedAt: row.pinnedAt?.toISOString() ?? null,
        archivedAt: row.archivedAt?.toISOString() ?? null,
        projectId: row.projectId
    };
}

/** What each list reads, by the rule `threadPlace` (shared.ts) sorts rows with:
 *  recents leave out pinned, archived and filed chats; a project's list keeps
 *  its pinned chats. */
export function viewQuery(
    userId: string,
    view: ThreadView,
    projectId?: string
): {
    where: Prisma.PolarThreadWhereInput;
    orderBy: Prisma.PolarThreadOrderByWithRelationInput[];
} {
    switch (view) {
        case "pinned":
            return {
                where: { userId, archivedAt: null, pinnedAt: { not: null } },
                orderBy: [{ pinnedAt: "desc" }, { id: "desc" }]
            };
        case "archived":
            return {
                where: { userId, archivedAt: { not: null } },
                orderBy: [{ archivedAt: "desc" }, { id: "desc" }]
            };
        case "project":
            return {
                where: { userId, archivedAt: null, projectId: projectId ?? "" },
                orderBy: [{ updatedAt: "desc" }, { id: "desc" }]
            };
        default:
            return {
                where: { userId, archivedAt: null, pinnedAt: null, projectId: null },
                orderBy: [{ updatedAt: "desc" }, { id: "desc" }]
            };
    }
}

export async function listPolarThreads(
    userId: string,
    cursor?: string,
    view: ThreadView = "recent",
    projectId?: string
): Promise<{ threads: PolarThreadRow[]; more: boolean }> {
    const rows = await prisma.polarThread.findMany({
        ...viewQuery(userId, view, projectId),
        select: ROW_SELECT,
        take: POLAR_THREAD_PAGE + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {})
    });
    return {
        threads: rows.slice(0, POLAR_THREAD_PAGE).map(toRow),
        more: rows.length > POLAR_THREAD_PAGE
    };
}

/** Everything the sidebar opens on, in one round trip: the first page of
 *  recents and of the pinned chats, whether each has another, and the
 *  projects. */
export async function polarSidebar(userId: string): Promise<{
    threads: PolarThreadRow[];
    more: boolean;
    pinned: PolarThreadRow[];
    morePinned: boolean;
    projects: PolarProjectRow[];
}> {
    const [recent, pinned, projects] = await Promise.all([
        listPolarThreads(userId),
        listPolarThreads(userId, undefined, "pinned"),
        prisma.polarProject.findMany({
            where: { ownerId: userId },
            select: { id: true, name: true, instructions: true },
            orderBy: [{ updatedAt: "desc" }, { id: "desc" }]
        })
    ]);
    return {
        threads: recent.threads,
        more: recent.more,
        pinned: pinned.threads,
        morePinned: pinned.more,
        projects
    };
}

/** Longest a search may read for, so a person with a long history waits a
 *  bounded time and the database is not held by one keystroke. */
const SEARCH_TIMEOUT_MS = 5000;

/** Escapes what ILIKE reads as a wildcard, so a search is for the text typed. */
export function likePattern(text: string): string {
    return `%${text.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

/**
 * The signed-in person's conversations whose title or message text holds the
 * words, newest first, archived ones included (that is how an archived chat is
 * found again). `page` counts from 0; `more` says whether another page exists.
 */
export async function searchPolarThreads(
    userId: string,
    text: string,
    page = 0
): Promise<{ results: PolarThreadRow[]; more: boolean }> {
    const pattern = likePattern(text);
    const [, rows] = await prisma.$transaction([
        prisma.$queryRaw(
            Prisma.sql`SELECT set_config('statement_timeout', ${String(SEARCH_TIMEOUT_MS)}, true)`
        ),
        prisma.$queryRaw<StoredRow[]>(Prisma.sql`
            SELECT t."id", t."title", t."updatedAt", t."pinnedAt", t."archivedAt", t."projectId"
            FROM "PolarThread" AS t
            WHERE t."userId" = ${userId}::uuid
              AND (
                t."title" ILIKE ${pattern}
                OR EXISTS (
                  SELECT 1
                  FROM "PolarMessage" AS m,
                       jsonb_array_elements(
                         CASE WHEN jsonb_typeof(m."parts") = 'array' THEN m."parts" ELSE '[]'::jsonb END
                       ) AS part
                  WHERE m."threadId" = t."id"
                    AND part->>'type' = 'text'
                    AND part->>'text' ILIKE ${pattern}
                )
              )
            ORDER BY t."updatedAt" DESC, t."id" DESC
            LIMIT ${POLAR_SEARCH_PAGE + 1}
            OFFSET ${page * POLAR_SEARCH_PAGE}
        `)
    ]);
    return {
        results: rows.slice(0, POLAR_SEARCH_PAGE).map(toRow),
        more: rows.length > POLAR_SEARCH_PAGE
    };
}

export interface PolarStoredMessage extends UIMessage {
    parentId: string | null;
}

export interface PolarThreadView {
    id: string;
    title: string;
    projectId: string | null;
    archivedAt: string | null;
    choice: ModelChoice | null;
    queue: QueuedMessage[];
    messages: PolarStoredMessage[];
}

/** Most messages one thread loads: the newest ones. */
const MESSAGE_LIMIT = 500;

export async function getPolarThread(userId: string, id: string): Promise<PolarThreadView | null> {
    const thread = await prisma.polarThread.findFirst({
        where: { id, userId },
        select: {
            id: true,
            title: true,
            projectId: true,
            archivedAt: true,
            choice: true,
            queue: true,
            messages: {
                select: { id: true, parentId: true, role: true, parts: true, metadata: true },
                orderBy: [{ createdAt: "desc" }, { id: "desc" }],
                take: MESSAGE_LIMIT
            }
        }
    });
    if (!thread) return null;
    const queue = queueSchema.safeParse(thread.queue);
    const rows = thread.messages.reverse();
    // A message whose parent is older than the newest MESSAGE_LIMIT starts the
    // part of the tree that was loaded.
    const loaded = new Set(rows.map((row) => row.id));
    return {
        id: thread.id,
        title: thread.title,
        projectId: thread.projectId,
        archivedAt: thread.archivedAt?.toISOString() ?? null,
        choice: (thread.choice as ModelChoice | null) ?? null,
        queue: queue.success ? queue.data : [],
        messages: rows.map((row) => ({
            id: row.id,
            parentId: row.parentId && loaded.has(row.parentId) ? row.parentId : null,
            role: row.role as UIMessage["role"],
            parts: (Array.isArray(row.parts) ? row.parts : []) as UIMessage["parts"],
            metadata: row.metadata ?? undefined
        }))
    };
}

/** A title from the first thing somebody asked: the placeholder until the
 *  model names the thread (`titles.ts`). */
export function titleFrom(text: string): string {
    const line = text.replace(/\s+/g, " ").trim();
    return line.length > 80 ? `${line.slice(0, 79)}...` : line || "New conversation";
}

/** Whether the project is this person's. */
async function ownsProject(userId: string, projectId: string): Promise<boolean> {
    return (await prisma.polarProject.count({ where: { id: projectId, ownerId: userId } })) > 0;
}

/** The thread, made if it is new - filed under `projectId` when that project is
 *  the person's. False when the id belongs to somebody else. */
export async function ensurePolarThread(
    userId: string,
    id: string,
    firstText: string,
    choice: ModelChoice,
    projectId: string | null = null
): Promise<boolean> {
    const existing = await prisma.polarThread.findUnique({
        where: { id },
        select: { userId: true }
    });
    if (existing) {
        if (existing.userId !== userId) return false;
        await prisma.polarThread.update({
            where: { id },
            data: { choice: choice as unknown as Prisma.InputJsonValue }
        });
        return true;
    }
    await prisma.polarThread.create({
        data: {
            id,
            userId,
            title: titleFrom(firstText),
            titleSource: "placeholder",
            projectId: projectId && (await ownsProject(userId, projectId)) ? projectId : null,
            choice: choice as unknown as Prisma.InputJsonValue
        }
    });
    return true;
}

/**
 * Writes the messages of a finished turn. A message already stored in this
 * thread is rewritten (an approval changes a tool part in place); a new one is
 * added after the message before it. An id already used in any other thread is
 * left alone: ids come from the browser, and one never reaches another thread.
 * The files the messages carry become this thread's, so they go with it.
 */
export async function savePolarMessages(
    userId: string,
    threadId: string,
    messages: readonly UIMessage[],
    parentOf: (index: number) => string | null
): Promise<void> {
    const owned = await prisma.polarThread.count({ where: { id: threadId, userId } });
    if (!owned) return;
    await prisma.$transaction([
        prisma.polarMessage.createMany({
            data: messages.map((message, index) => ({
                id: message.id,
                threadId,
                parentId: parentOf(index),
                role: message.role,
                parts: message.parts as unknown as Prisma.InputJsonValue,
                metadata: (message.metadata ?? undefined) as Prisma.InputJsonValue | undefined
            })),
            skipDuplicates: true
        }),
        ...messages.map((message) =>
            prisma.polarMessage.updateMany({
                where: { id: message.id, threadId },
                data: {
                    parts: message.parts as unknown as Prisma.InputJsonValue,
                    metadata: (message.metadata ?? undefined) as Prisma.InputJsonValue | undefined
                }
            })
        ),
        prisma.polarThread.update({ where: { id: threadId }, data: { updatedAt: new Date() } })
    ]);
    await linkPolarAttachments(userId, threadId, messages);
}

export async function renamePolarThread(
    userId: string,
    id: string,
    title: string
): Promise<boolean> {
    const { count } = await prisma.polarThread.updateMany({
        where: { id, userId },
        data: { title, titleSource: "user" }
    });
    return count > 0;
}

/** What the menu changes on a conversation: pinned, archived, its project. */
export interface PolarThreadChange {
    pinned?: boolean;
    archived?: boolean;
    /** Null takes it out of its project. */
    projectId?: string | null;
}

/**
 * False when the thread, or the project it is moved to, is not this person's.
 * None of these counts as activity: the chat keeps its place among the recents,
 * so `updatedAt` is written back as it was.
 */
export async function changePolarThread(
    userId: string,
    id: string,
    change: PolarThreadChange
): Promise<boolean> {
    if (change.projectId && !(await ownsProject(userId, change.projectId))) return false;
    const current = await prisma.polarThread.findFirst({
        where: { id, userId },
        select: { pinnedAt: true, archivedAt: true, updatedAt: true }
    });
    if (!current) return false;
    const now = new Date();
    const data: Prisma.PolarThreadUncheckedUpdateManyInput = { updatedAt: current.updatedAt };
    if (change.pinned !== undefined) {
        data.pinnedAt = change.pinned ? (current.pinnedAt ?? now) : null;
    }
    if (change.archived !== undefined) {
        data.archivedAt = change.archived ? (current.archivedAt ?? now) : null;
        // An archived chat stops being pinned.
        if (change.archived) data.pinnedAt = null;
    }
    if (change.projectId !== undefined) data.projectId = change.projectId;
    const { count } = await prisma.polarThread.updateMany({ where: { id, userId }, data });
    return count > 0;
}

/** The instructions of the project a thread is filed under, or null. */
export async function polarThreadInstructions(
    userId: string,
    threadId: string
): Promise<string | null> {
    const thread = await prisma.polarThread.findFirst({
        where: { id: threadId, userId },
        select: { project: { select: { instructions: true } } }
    });
    const text = thread?.project?.instructions.trim();
    return text ? text : null;
}

export async function setPolarQueue(
    userId: string,
    id: string,
    queue: QueuedMessage[]
): Promise<boolean> {
    const { count } = await prisma.polarThread.updateMany({
        where: { id, userId },
        data: { queue: queue as unknown as Prisma.InputJsonValue }
    });
    return count > 0;
}

export async function deletePolarThread(userId: string, id: string): Promise<boolean> {
    const files = await threadAttachments(userId, id);
    const { count } = await prisma.polarThread.deleteMany({ where: { id, userId } });
    if (count > 0) await discardPolarAttachments(files);
    return count > 0;
}
