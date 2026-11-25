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
 *
 * Polaris queues messages of its own here too: what the session's pull request
 * says needs fixing (`session-feedback.ts`). Those carry a `feedbackKey`, and
 * the ones waiting next to each other go as one turn, stopping before the next
 * typed message, which always gets a turn of its own (Agent Orchestrator's
 * batching rule, docs/architecture.md "Feedback routing flow", Apache-2.0).
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

/**
 * Queue a message Polaris wrote about the session's pull request, under the
 * fact it reports: a newer word on the same fact replaces the one still
 * waiting instead of queuing a second. False when the queue is full.
 */
export async function queueFeedback(
    sessionId: string,
    authorId: string,
    feedbackKey: string,
    text: string
): Promise<boolean> {
    const waiting = await prisma.agentQueuedPrompt.findUnique({
        where: { sessionId_feedbackKey: { sessionId, feedbackKey } },
        select: { id: true }
    });
    if (waiting) {
        await prisma.agentQueuedPrompt.update({ where: { id: waiting.id }, data: { text } });
        return true;
    }
    if ((await queuedCount(sessionId)) >= QUEUE_MAX) return false;
    await prisma.agentQueuedPrompt.upsert({
        where: { sessionId_feedbackKey: { sessionId, feedbackKey } },
        create: { sessionId, authorId, text, feedbackKey },
        update: { text }
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
 * Where a queued message goes when it is moved one place up or down, or sent
 * now (to the front): the `createdAt` it takes, which is the order the queue
 * is read in. Null when it is already there or is not in the list. A move
 * trades places with its neighbour; the front goes a millisecond before the
 * head. Pure.
 */
export function reorderedAt(
    rows: readonly { id: string; createdAt: Date }[],
    id: string,
    to: "up" | "down" | "front"
): { at: Date; neighbour?: { id: string; at: Date } } | null {
    const index = rows.findIndex((row) => row.id === id);
    const row = rows[index];
    if (!row) return null;
    if (to === "front") {
        const head = rows[0];
        return index === 0 || !head ? null : { at: new Date(head.createdAt.getTime() - 1) };
    }
    const other = rows[to === "up" ? index - 1 : index + 1];
    if (!other) return null;
    // Two typed in the same millisecond still trade places.
    const same = other.createdAt.getTime() === row.createdAt.getTime();
    const at = same ? new Date(other.createdAt.getTime() + (to === "up" ? -1 : 1)) : other.createdAt;
    return { at, neighbour: { id: other.id, at: row.createdAt } };
}

/**
 * Move a waiting message one place up or down, or to the front so it is the
 * next to go. False when it already went (or is already there).
 */
export async function reorderQueuedPrompt(
    sessionId: string,
    id: string,
    to: "up" | "down" | "front"
): Promise<boolean> {
    const rows = await prisma.agentQueuedPrompt.findMany({
        where: { sessionId },
        orderBy: { createdAt: "asc" },
        take: QUEUE_MAX,
        select: { id: true, createdAt: true }
    });
    const move = reorderedAt(rows, id, to);
    if (!move) return rows.some((row) => row.id === id) && to === "front";
    const writes = [prisma.agentQueuedPrompt.updateMany({ where: { id, sessionId }, data: { createdAt: move.at } })];
    if (move.neighbour)
        writes.push(
            prisma.agentQueuedPrompt.updateMany({
                where: { id: move.neighbour.id, sessionId },
                data: { createdAt: move.neighbour.at }
            })
        );
    const [moved] = await prisma.$transaction(writes);
    return moved?.count === 1;
}

/**
 * Take every message the person typed back out of the queue, oldest first,
 * for "stop and wait": nothing they typed goes once the turn is stopped, and
 * the words come back to the box instead of being lost. Polaris's own
 * messages about the pull request stay.
 */
export async function takeBackTypedPrompts(sessionId: string): Promise<string[]> {
    const rows = await prisma.agentQueuedPrompt.findMany({
        where: { sessionId, feedbackKey: null },
        orderBy: { createdAt: "asc" },
        take: QUEUE_MAX,
        select: { id: true, text: true }
    });
    const back: string[] = [];
    for (const row of rows) {
        // A row delivery claimed first already went.
        if ((await prisma.agentQueuedPrompt.deleteMany({ where: { id: row.id, sessionId } })).count === 1)
            back.push(row.text);
    }
    return back;
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
    // Sent from Polar Code: answered in Chat where the session can hand off.
    await runtime.promptSession(session.id, said, { fromChat: true });
    return {};
}

/**
 * Send a message typed while the agent works into its running turn, kept on
 * the session only once the agent took it. False when it could not go now
 * (no steering here, no turn of Chat's running, files to place first); the
 * caller queues it. Files wait for the queue because placing them is a step
 * the agent would read mid-turn before they exist.
 */
export async function steerPromptNow(
    session: sessions.SessionView,
    userId: string,
    text: string,
    attachmentIds: readonly string[]
): Promise<boolean> {
    if (attachmentIds.length > 0) return false;
    if (!(await runtime.steerTurn(session.id, text))) return false;
    await sessions.addSessionMessage(session.id, "user", text, userId);
    return true;
}

/** One waiting row, as delivery reads it. */
export interface QueuedRow {
    id: string;
    text: string;
    authorId: string;
    attachments: string[];
    createdAt: Date;
    /** Set on a message Polaris queued itself. */
    feedbackKey?: string | null;
}

/** The most of Polaris's own messages that go together in one turn. */
export const BATCH_MAX = 10;

/** Between two messages that go as one turn. */
const BATCH_SEPARATOR = "\n\n---\n\n";

/**
 * What the next turn carries, from the oldest rows first: a typed message
 * alone, or the run of Polaris's own messages at the front of the queue up to
 * the next typed one. Pure.
 */
export function deliveryBatch<T extends Pick<QueuedRow, "feedbackKey">>(rows: readonly T[]): T[] {
    const first = rows[0];
    if (!first) return [];
    if (!first.feedbackKey) return [first];
    const batch: T[] = [];
    for (const row of rows) {
        if (!row.feedbackKey || batch.length >= BATCH_MAX) break;
        batch.push(row);
    }
    return batch;
}

/** What delivery needs from outside, so its order can be tested alone. */
export interface QueuePorts {
    /** The oldest waiting rows, oldest first, at most `limit`. */
    head(sessionId: string, limit: number): Promise<QueuedRow[]>;
    claim(id: string): Promise<boolean>;
    putBack(sessionId: string, row: Omit<QueuedRow, "id">): Promise<void>;
    send(sessionId: string, authorId: string, text: string, attachments: readonly string[]): Promise<void>;
}

const PORTS: QueuePorts = {
    head: (sessionId, limit) =>
        prisma.agentQueuedPrompt.findMany({
            where: { sessionId },
            orderBy: { createdAt: "asc" },
            take: limit,
            select: { id: true, text: true, authorId: true, attachments: true, createdAt: true, feedbackKey: true }
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
 * Send the next turn's worth of waiting messages, after a turn ended: the
 * oldest typed message alone, or the run of Polaris's own messages before the
 * next typed one, together. True when something went. A send that fails puts
 * every message back where it was, so the next turn end (or the next message
 * typed) tries again.
 */
export async function deliverNextQueued(sessionId: string, ports: QueuePorts = PORTS): Promise<boolean> {
    const batch: QueuedRow[] = [];
    for (const row of deliveryBatch(await ports.head(sessionId, BATCH_MAX))) {
        // A row another delivery claimed first is that delivery's to send.
        if (await ports.claim(row.id)) batch.push(row);
    }
    const first = batch[0];
    if (!first) return false;
    const text = batch.map((row) => row.text).join(BATCH_SEPARATOR);
    try {
        await ports.send(sessionId, first.authorId, text, batch.flatMap((row) => row.attachments));
        return true;
    } catch (error) {
        console.error(`[agent-session] ${sessionId}: a queued message was not delivered`, error);
        for (const row of batch) {
            await ports
                .putBack(sessionId, {
                    text: row.text,
                    authorId: row.authorId,
                    attachments: row.attachments,
                    createdAt: row.createdAt,
                    feedbackKey: row.feedbackKey ?? null
                })
                .catch(() => undefined);
        }
        return false;
    }
}
