/**
 * Messages typed while the agent is mid-turn, held until the turn ends.
 *
 * Claude Code queues what is typed while it works and sends it once the turn
 * is over; until then the message can be taken back
 * (https://code.claude.com/docs/en/claude-code-on-the-web). Here the queue is a
 * table, so every device that opens the session sees the same messages, in the
 * order they were typed, and can edit or remove one before it goes.
 *
 * One message is sent per finished turn, oldest first: the `turn.end` hook
 * (`/api/agents/sessions/:id/events`) calls `deliverNextQueued`. A message is
 * claimed by deleting its row, so two deliveries never send the same one; a
 * send that fails puts it back at the front.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import * as runtime from "@/lib/agents/session-runtime";
import * as sessions from "@/lib/agents/session-service";
import * as sessionAttachments from "@/lib/agents/session-attachments";

/** The most messages one session holds in its queue. */
export const QUEUE_MAX = 20;

/** One queued message, as the thread shows it. */
export interface QueuedPrompt {
    readonly id: string;
    readonly text: string;
    readonly at: string;
    /** How many files it carries. */
    readonly files: number;
}

/**
 * Whether a message typed now waits in the queue: while the agent is mid-turn,
 * and while anything is already waiting, so nothing jumps the line. Pure.
 */
export function shouldQueuePrompt(state: core.AgentSessionState, waiting: number): boolean {
    return state === "working" || (waiting > 0 && !core.isSessionOver(state));
}

/** The session's queue, oldest first. */
export async function listQueuedPrompts(sessionId: string): Promise<QueuedPrompt[]> {
    const rows = await prisma.agentQueuedPrompt.findMany({
        where: { sessionId },
        orderBy: { createdAt: "asc" },
        take: QUEUE_MAX,
        select: { id: true, text: true, createdAt: true, attachments: true }
    });
    return rows.map((row) => ({
        id: row.id,
        text: row.text,
        at: row.createdAt.toISOString(),
        files: row.attachments.length
    }));
}

export async function queuedCount(sessionId: string): Promise<number> {
    return prisma.agentQueuedPrompt.count({ where: { sessionId } });
}

/** Put a message at the back of the queue; false when the queue is full. */
export async function queuePrompt(
    sessionId: string,
    authorId: string,
    text: string,
    attachments: readonly string[]
): Promise<boolean> {
    if ((await queuedCount(sessionId)) >= QUEUE_MAX) return false;
    await prisma.agentQueuedPrompt.create({
        data: { sessionId, authorId, text, attachments: [...attachments] }
    });
    return true;
}

/** Change a message still waiting; false when it was already sent or removed. */
export async function editQueuedPrompt(sessionId: string, id: string, text: string): Promise<boolean> {
    const changed = await prisma.agentQueuedPrompt.updateMany({ where: { id, sessionId }, data: { text } });
    return changed.count === 1;
}

/** Take a message back out of the queue: its text, or null when it already
 *  went (or never was there). */
export async function takeBackQueuedPrompt(sessionId: string, id: string): Promise<string | null> {
    const row = await prisma.agentQueuedPrompt.findFirst({ where: { id, sessionId }, select: { text: true } });
    if (!row) return null;
    const removed = await prisma.agentQueuedPrompt.deleteMany({ where: { id, sessionId } });
    return removed.count === 1 ? row.text : null;
}

/**
 * Send a message to the agent now: its files placed on the machine, the
 * message kept on the session, then handed to the agent. A refusal about the
 * files comes back; anything the machine answers throws.
 */
export async function sendPromptNow(
    session: sessions.SessionView,
    userId: string,
    text: string,
    attachmentIds: readonly string[]
): Promise<{ refusal?: "missing" | "tooLarge" }> {
    const files = await sessionAttachments.sessionAttachmentsFor(userId, attachmentIds);
    if ("refusal" in files) return { refusal: files.refusal };
    const said = sessionAttachments.withAttachmentNote(
        text,
        files.files.map((file) => file.path)
    );
    await sessions.addSessionMessage(session.id, "user", said, userId);
    await runtime.placeAttachments(session, userId, files.files);
    await runtime.promptSession(session.id, said);
    return {};
}

/** What delivery needs from outside, so its order can be tested alone. */
export interface QueuePorts {
    oldest(sessionId: string): Promise<{
        id: string;
        text: string;
        authorId: string;
        attachments: string[];
        createdAt: Date;
    } | null>;
    claim(id: string): Promise<boolean>;
    putBack(sessionId: string, row: { text: string; authorId: string; attachments: string[]; createdAt: Date }): Promise<void>;
    send(sessionId: string, authorId: string, text: string, attachments: readonly string[]): Promise<void>;
}

const PORTS: QueuePorts = {
    oldest: (sessionId) =>
        prisma.agentQueuedPrompt.findFirst({
            where: { sessionId },
            orderBy: { createdAt: "asc" },
            select: { id: true, text: true, authorId: true, attachments: true, createdAt: true }
        }),
    claim: async (id) => (await prisma.agentQueuedPrompt.deleteMany({ where: { id } })).count === 1,
    putBack: async (sessionId, row) => {
        await prisma.agentQueuedPrompt.create({ data: { sessionId, ...row } });
    },
    send: async (sessionId, authorId, text, attachments) => {
        const session = await sessions.getSession(sessionId, authorId);
        if (!session || !core.isSessionListening(session.state)) throw new Error("The session is not listening");
        const sent = await sendPromptNow(session, authorId, text, attachments);
        // Files gone since it was queued: the words still go, without them.
        if (sent.refusal) await sendPromptNow(session, authorId, text, []);
    }
};

/**
 * Send the oldest waiting message, after a turn ended. True when one went.
 * A send that fails puts the message back where it was, so the next turn end
 * (or the next message typed) tries it again.
 */
export async function deliverNextQueued(sessionId: string, ports: QueuePorts = PORTS): Promise<boolean> {
    const next = await ports.oldest(sessionId);
    if (!next || !(await ports.claim(next.id))) return false;
    try {
        await ports.send(sessionId, next.authorId, next.text, next.attachments);
        return true;
    } catch (error) {
        console.error(`[agent-session] ${sessionId}: a queued message was not delivered`, error);
        await ports
            .putBack(sessionId, {
                text: next.text,
                authorId: next.authorId,
                attachments: next.attachments,
                createdAt: next.createdAt
            })
            .catch(() => undefined);
        return false;
    }
}
