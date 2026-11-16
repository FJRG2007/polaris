/**
 * Importing a Polar chat from the JSON a Polar export writes (`threadJson`,
 * format version 1), as a new chat of the person importing it.
 *
 * The file is untrusted: it is size-capped before it is parsed, held to a Zod
 * schema of that version, and only words come over - the newest version of each
 * turn, the text and reasoning of each message. Tool calls, approvals, files
 * and metadata are left behind, so an imported chat never runs a tool, asks for
 * an approval or points at somebody's storage. Ids are new, so importing the
 * same file twice is two chats rather than a clash.
 */

import { z } from "zod";
import { randomUUID } from "node:crypto";
import { prisma, Prisma } from "@polaris/db";
import { newestPath, type ExportMessage } from "@/lib/polar/export";

/** The largest file read. A 5000-message export of ordinary chat fits well. */
export const MAX_IMPORT_BYTES = 8 * 1024 * 1024;

/** Messages in one file at most: what one export carries. */
export const MAX_IMPORT_MESSAGES = 5000;

/** Characters of one message kept. */
export const MAX_IMPORT_TEXT = 200_000;

const TITLE_CHARS = 200;

const partSchema = z.object({ type: z.string().max(100) }).passthrough();

const messageSchema = z.object({
    id: z.string().min(1).max(200),
    parentId: z.string().min(1).max(200).nullable(),
    role: z.string().max(40),
    parts: z.array(partSchema).max(1000),
    createdAt: z.string().datetime({ offset: true }).optional()
});

export const threadImportSchema = z.object({
    version: z.literal(1),
    title: z.string().max(10_000),
    truncated: z.boolean().optional(),
    messages: z.array(messageSchema).max(MAX_IMPORT_MESSAGES)
});

export interface ImportedMessage {
    role: "user" | "assistant";
    parts: ({ type: "text"; text: string } | { type: "reasoning"; text: string })[];
}

export interface ImportedThread {
    title: string;
    messages: ImportedMessage[];
}

export type ImportRefusal = "large" | "json" | "version" | "shape" | "empty";

/** Words only, from the parts a message carried. */
function wordsOf(parts: readonly z.infer<typeof partSchema>[]): ImportedMessage["parts"] {
    const kept: ImportedMessage["parts"] = [];
    let left = MAX_IMPORT_TEXT;
    for (const part of parts) {
        if ((part.type !== "text" && part.type !== "reasoning") || typeof part.text !== "string") continue;
        const text = part.text.slice(0, left);
        if (!text.trim()) continue;
        kept.push({ type: part.type, text });
        left -= text.length;
        if (left <= 0) break;
    }
    return kept;
}

/** Reads an export's text into the chat it holds, or why it cannot. Pure. */
export function parseThreadImport(text: string): { thread: ImportedThread } | { refusal: ImportRefusal } {
    if (Buffer.byteLength(text, "utf8") > MAX_IMPORT_BYTES) return { refusal: "large" };
    let json: unknown;
    try {
        json = JSON.parse(text);
    } catch {
        return { refusal: "json" };
    }
    const version = (json as { version?: unknown } | null)?.version;
    if (typeof json !== "object" || json === null || version !== 1) return { refusal: "version" };
    const parsed = threadImportSchema.safeParse(json);
    if (!parsed.success) return { refusal: "shape" };
    const path = newestPath(
        parsed.data.messages.map(
            (message): ExportMessage => ({ ...message, metadata: null, createdAt: message.createdAt ?? "" })
        )
    );
    const messages: ImportedMessage[] = [];
    for (const message of path) {
        if (message.role !== "user" && message.role !== "assistant") continue;
        const parts = wordsOf(message.parts as z.infer<typeof partSchema>[]);
        if (parts.length > 0) messages.push({ role: message.role, parts });
    }
    if (messages.length === 0) return { refusal: "empty" };
    const title = parsed.data.title.replace(/\s+/g, " ").trim().slice(0, TITLE_CHARS);
    return { thread: { title, messages } };
}

/** Saves an imported chat as a new one of this person's; its id. */
export async function importThread(userId: string, thread: ImportedThread, fallbackTitle: string): Promise<string> {
    return prisma.$transaction(async (tx) => {
        const created = await tx.polarThread.create({
            data: { userId, title: thread.title || fallbackTitle, titleSource: "user" },
            select: { id: true }
        });
        const base = Date.now();
        let parentId: string | null = null;
        const data = thread.messages.map((message, index) => {
            const id = randomUUID();
            const row = {
                id,
                threadId: created.id,
                parentId,
                role: message.role,
                parts: message.parts as Prisma.InputJsonValue,
                // One millisecond apart, so the order they were written in is kept.
                createdAt: new Date(base + index)
            };
            parentId = id;
            return row;
        });
        await tx.polarMessage.createMany({ data });
        return created.id;
    });
}
