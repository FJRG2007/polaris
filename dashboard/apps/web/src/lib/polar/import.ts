/**
 * Importing a Polar chat from the JSON a Polar export writes (`threadJson`,
 * format version 1), or an OpenCode session from what `opencode export` prints,
 * as a new chat of the person importing it.
 *
 * OpenCode has written two shapes, both `{ info, messages }` with the session's
 * `info.title`: since v2 each message is typed (`user` with its `text`,
 * `assistant` with `content` parts of `text`, `reasoning` and `tool`;
 * `SessionTransfer.Data` in its `packages/schema`), and before it each message
 * was `{ info: { role }, parts }` (v1.0.0 `cli/cmd/export.ts`). A tool call
 * comes over as a line naming the tool and, where the export has one, its
 * title; synthetic text, shell runs, compactions and switches are left out.
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

const openCodeToolState = z
    .object({ status: z.string().max(40), title: z.string().max(10_000).optional() })
    .passthrough();

const openCodeContent = z
    .object({
        type: z.string().max(100),
        text: z.string().optional(),
        name: z.string().max(500).optional()
    })
    .passthrough();

/** One OpenCode message as v2 exports it; only `user` and `assistant` carry
 *  words, any other kind is kept to its type and skipped. */
const openCodeMessage = z.object({
    type: z.string().max(100),
    text: z.string().optional(),
    content: z.array(openCodeContent).max(5000).optional()
});

/** One OpenCode message as v1 exported it. */
const openCodeV1Message = z.object({
    info: z.object({ role: z.string().max(40) }).passthrough(),
    parts: z
        .array(
            z
                .object({
                    type: z.string().max(100),
                    text: z.string().optional(),
                    synthetic: z.boolean().optional(),
                    ignored: z.boolean().optional(),
                    tool: z.string().max(500).optional(),
                    state: openCodeToolState.optional()
                })
                .passthrough()
        )
        .max(5000)
});

export const openCodeImportSchema = z.object({
    info: z.object({ title: z.string().max(10_000).optional() }).passthrough(),
    messages: z.union([
        z.array(openCodeV1Message).max(MAX_IMPORT_MESSAGES),
        z.array(openCodeMessage).max(MAX_IMPORT_MESSAGES)
    ])
});

type Piece = { type: "text" | "reasoning"; text: string } | { tool: string };

/** A tool call in words: its name in code, then its title when there is one. */
function toolLine(name: string, title: string | undefined): string {
    const said = title?.replace(/\s+/g, " ").trim();
    return said ? `\`${name}\` - ${said}` : `\`${name}\``;
}

/** Text and tool lines in order, a run of tool lines as one text part. */
function openCodeWords(pieces: readonly Piece[]): ImportedMessage["parts"] {
    const parts: { type: "text" | "reasoning"; text: string }[] = [];
    let tools: string[] = [];
    const flush = () => {
        if (tools.length > 0) parts.push({ type: "text", text: tools.join("\n") });
        tools = [];
    };
    for (const piece of pieces) {
        if ("tool" in piece) tools.push(piece.tool);
        else {
            flush();
            parts.push(piece);
        }
    }
    flush();
    return wordsOf(parts);
}

function v1Pieces(parts: z.infer<typeof openCodeV1Message>["parts"]): Piece[] {
    return parts.flatMap((part): Piece[] => {
        if ((part.type === "text" || part.type === "reasoning") && typeof part.text === "string")
            return part.synthetic || part.ignored ? [] : [{ type: part.type, text: part.text }];
        if (part.type === "tool" && part.tool) return [{ tool: toolLine(part.tool, part.state?.title) }];
        return [];
    });
}

function contentPieces(content: readonly z.infer<typeof openCodeContent>[]): Piece[] {
    return content.flatMap((part): Piece[] => {
        if ((part.type === "text" || part.type === "reasoning") && typeof part.text === "string")
            return [{ type: part.type, text: part.text }];
        if (part.type === "tool" && part.name) return [{ tool: toolLine(part.name, undefined) }];
        return [];
    });
}

/** An OpenCode export's words, in the order it lists them. Pure. */
function openCodeThread(data: z.infer<typeof openCodeImportSchema>): ImportedThread {
    const messages: ImportedMessage[] = [];
    for (const message of data.messages) {
        let said: ImportedMessage | null = null;
        if ("info" in message) {
            const role = message.info.role;
            if (role === "user" || role === "assistant")
                said = { role, parts: openCodeWords(v1Pieces(message.parts)) };
        } else if (message.type === "user" && typeof message.text === "string") {
            said = { role: "user", parts: wordsOf([{ type: "text", text: message.text }]) };
        } else if (message.type === "assistant" && message.content) {
            said = { role: "assistant", parts: openCodeWords(contentPieces(message.content)) };
        }
        if (said && said.parts.length > 0) messages.push(said);
    }
    const title = (data.info.title ?? "").replace(/\s+/g, " ").trim().slice(0, TITLE_CHARS);
    return { title, messages };
}

/** Whether a parsed file is shaped like an OpenCode export: `{ info, messages }`. */
function looksOpenCode(value: unknown): value is { info: object; messages: unknown[] } {
    if (typeof value !== "object" || value === null) return false;
    const { info, messages } = value as { info?: unknown; messages?: unknown };
    return typeof info === "object" && info !== null && Array.isArray(messages);
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
    if (typeof json !== "object" || json === null) return { refusal: "version" };
    const version = (json as { version?: unknown }).version;
    // `opencode export` prints the transfer itself; its API answers it in `data`.
    const wrapped = (json as { data?: unknown }).data;
    const openCode = looksOpenCode(json) ? json : looksOpenCode(wrapped) ? wrapped : null;
    if (version === undefined && openCode) {
        const parsed = openCodeImportSchema.safeParse(openCode);
        if (!parsed.success) return { refusal: "shape" };
        const thread = openCodeThread(parsed.data);
        return thread.messages.length > 0 ? { thread } : { refusal: "empty" };
    }
    if (version !== 1) return { refusal: "version" };
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
