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
import { prisma, type Prisma } from "@polaris/db";
import {
    discardPolarAttachments,
    linkPolarAttachments,
    threadAttachments
} from "@/lib/polar/attachments";
import {
    POLAR_THREAD_PAGE,
    queueSchema,
    type ModelChoice,
    type QueuedMessage
} from "@/lib/polar/shared";

export interface PolarThreadRow {
    id: string;
    title: string;
    updatedAt: string;
}

export async function listPolarThreads(userId: string, cursor?: string): Promise<PolarThreadRow[]> {
    const rows = await prisma.polarThread.findMany({
        where: { userId },
        select: { id: true, title: true, updatedAt: true },
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        take: POLAR_THREAD_PAGE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {})
    });
    return rows.map((row) => ({ ...row, updatedAt: row.updatedAt.toISOString() }));
}

export interface PolarStoredMessage extends UIMessage {
    parentId: string | null;
}

export interface PolarThreadView {
    id: string;
    title: string;
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

/** The thread, made if it is new. Null when the id belongs to somebody else. */
export async function ensurePolarThread(
    userId: string,
    id: string,
    firstText: string,
    choice: ModelChoice
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
