/**
 * A Polar conversation as a file the person keeps: Markdown to read (the path
 * the screen shows, newest version of each turn) or JSON to keep everything
 * (every message and version, with its parent, parts and metadata). All of a
 * person's chats leave as one zip, streamed one chat at a time.
 *
 * Temporary chats are never in the zip; every other one is, read a page of
 * chats at a time. A chat longer than one export carries keeps its newest
 * messages and says so in both files. Every read names the owner.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import { getTranslations } from "@/lib/i18n/request";
import { compactionOf } from "@/lib/polar/compaction";
import { isVisualPart, visualPartMarkdown } from "@/lib/polar/visuals";
import { createZipStream, type ZipSource } from "@/lib/zip-stream";

/** Most messages one exported chat carries; the newest ones. */
const EXPORT_MESSAGES_MOST = 5000;
/** Chats the zip reads per query. */
const EXPORT_THREADS_PAGE = 200;

export type ExportFormat = "markdown" | "json";

export interface ExportMessage {
    id: string;
    parentId: string | null;
    role: string;
    parts: unknown[];
    metadata: unknown;
    createdAt: string;
}

export interface ExportThread {
    id: string;
    title: string;
    createdAt: string;
    updatedAt: string;
    /** Older messages were left out: the chat is longer than one export carries. */
    truncated: boolean;
    messages: ExportMessage[];
}

/** The words a Markdown export is written in, in the reader's language. */
export interface ExportNames {
    user: string;
    assistant: string;
    untitled: string;
    attachment: string;
    file: (name: string) => string;
    used: (name: string) => string;
    truncated: string;
    compacted: (auto: boolean) => string;
}

export async function exportNames(): Promise<ExportNames> {
    const t = await getTranslations("polar");
    return {
        user: t("export.you"),
        assistant: "Polar",
        untitled: t("export.untitled"),
        attachment: t("export.attachment"),
        file: (name) => t("export.file", { name }),
        used: (name) => t("export.used", { name }),
        truncated: t("export.truncated", { most: EXPORT_MESSAGES_MOST }),
        compacted: (auto) => t(auto ? "compact.dividerAuto" : "compact.divider")
    };
}

/** The newest version of every turn, root to leaf: what the chat shows. */
export function newestPath(messages: readonly ExportMessage[]): ExportMessage[] {
    const ids = new Set(messages.map((message) => message.id));
    const children = new Map<string | null, ExportMessage[]>();
    for (const message of messages) {
        // A parent older than what was loaded starts the loaded part.
        const parent = message.parentId && ids.has(message.parentId) ? message.parentId : null;
        const list = children.get(parent) ?? [];
        list.push(message);
        children.set(parent, list);
    }
    const path: ExportMessage[] = [];
    let next = children.get(null)?.at(-1);
    const seen = new Set<string>();
    while (next && !seen.has(next.id)) {
        seen.add(next.id);
        path.push(next);
        next = children.get(next.id)?.at(-1);
    }
    return path;
}

type Part = { type?: unknown; text?: unknown; filename?: unknown; toolName?: unknown };

/** One message's parts as Markdown: its words, the files it carried by name,
 *  the tools it used by name, and each view it drew as Markdown. Tool inputs
 *  and outputs stay in the JSON. */
function partsMarkdown(parts: readonly unknown[], names: ExportNames): string {
    const lines: string[] = [];
    for (const raw of parts) {
        const part = (raw ?? {}) as Part;
        const type = typeof part.type === "string" ? part.type : "";
        if (type === "text" && typeof part.text === "string" && part.text.trim()) {
            lines.push(part.text.trim());
        } else if (type === "file") {
            lines.push(
                `> ${names.file(typeof part.filename === "string" ? part.filename : names.attachment)}`
            );
        } else if (isVisualPart(part)) {
            // A view Polar drew is kept as its Markdown; one that never drew is left out.
            const visual = visualPartMarkdown(part as never);
            if (visual) lines.push(visual);
        } else if (type.startsWith("tool-") || type === "dynamic-tool") {
            const name = type === "dynamic-tool" ? String(part.toolName ?? "tool") : type.slice(5);
            lines.push(`> ${names.used(name)}`);
        }
    }
    return lines.join("\n\n");
}

export function threadMarkdown(thread: ExportThread, names: ExportNames): string {
    const blocks = [
        `# ${thread.title.replace(/\s+/g, " ").trim() || names.untitled}`,
        `_${thread.createdAt}_`
    ];
    if (thread.truncated) blocks.push(`> ${names.truncated}`);
    for (const message of newestPath(thread.messages)) {
        const compaction = compactionOf({ role: message.role, metadata: message.metadata });
        if (compaction) {
            blocks.push("---", `_${names.compacted(compaction.auto)}_`);
            continue;
        }
        const body = partsMarkdown(message.parts, names);
        if (!body) continue;
        blocks.push(`## ${message.role === "user" ? names.user : names.assistant}`, body);
    }
    return `${blocks.join("\n\n")}\n`;
}

export function threadJson(thread: ExportThread): string {
    return `${JSON.stringify({ version: 1, ...thread }, null, 2)}\n`;
}

/** A file name a browser keeps as typed: ASCII, no separators. */
export function exportFileName(title: string, id: string, extension: string): string {
    const slug = title
        .normalize("NFKD")
        .replace(/[^\x20-\x7e]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 60);
    return `${slug || "chat"}-${id.slice(0, 8)}.${extension}`;
}

/** One chat with its messages, or null when it is not this person's. */
export async function readExportThread(userId: string, id: string): Promise<ExportThread | null> {
    const thread = await prisma.polarThread.findFirst({
        where: { id, userId },
        select: {
            id: true,
            title: true,
            createdAt: true,
            updatedAt: true,
            messages: {
                select: {
                    id: true,
                    parentId: true,
                    role: true,
                    parts: true,
                    metadata: true,
                    createdAt: true
                },
                orderBy: [{ createdAt: "desc" }, { id: "desc" }],
                take: EXPORT_MESSAGES_MOST + 1
            }
        }
    });
    if (!thread) return null;
    const truncated = thread.messages.length > EXPORT_MESSAGES_MOST;
    if (truncated) thread.messages.length = EXPORT_MESSAGES_MOST;
    return {
        id: thread.id,
        title: thread.title,
        createdAt: thread.createdAt.toISOString(),
        updatedAt: thread.updatedAt.toISOString(),
        truncated,
        messages: thread.messages.reverse().map((message) => ({
            id: message.id,
            parentId: message.parentId,
            role: message.role,
            parts: Array.isArray(message.parts) ? (message.parts as unknown[]) : [],
            metadata: message.metadata ?? null,
            createdAt: message.createdAt.toISOString()
        }))
    };
}

function textStream(text: string): ReadableStream<Uint8Array> {
    const bytes = new TextEncoder().encode(text);
    return new ReadableStream({
        start(controller) {
            controller.enqueue(bytes);
            controller.close();
        }
    });
}

/** Every saved chat of the person, a page at a time, newest first. Ordered by
 *  creation so a chat touched while the zip is written is neither skipped nor
 *  repeated. */
async function* savedThreads(
    userId: string,
    ids: readonly string[] | null
): AsyncGenerator<{ id: string; title: string; updatedAt: Date }> {
    let cursor: string | null = null;
    for (;;) {
        const page: { id: string; title: string; updatedAt: Date }[] =
            await prisma.polarThread.findMany({
                where: { userId, temporary: false, ...(ids ? { id: { in: [...ids] } } : {}) },
                select: { id: true, title: true, updatedAt: true },
                orderBy: [{ createdAt: "desc" }, { id: "desc" }],
                take: EXPORT_THREADS_PAGE,
                ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {})
            });
        yield* page;
        if (page.length < EXPORT_THREADS_PAGE) return;
        cursor = page[page.length - 1]!.id;
    }
}

/** Every saved chat of the person as a zip (or only `ids`, a selection): a
 *  Markdown and a JSON file each. Each chat is read only when the archive
 *  reaches it. */
export async function exportAllThreads(
    userId: string,
    names: ExportNames,
    ids: readonly string[] | null = null
): Promise<ReadableStream<Uint8Array>> {
    async function* sources(): AsyncGenerator<ZipSource> {
        yield { name: "markdown/", kind: "dir", size: 0n };
        yield { name: "json/", kind: "dir", size: 0n };
        for await (const row of savedThreads(userId, ids)) {
            const thread = await readExportThread(userId, row.id);
            if (!thread) continue;
            const markdown = threadMarkdown(thread, names);
            const json = threadJson(thread);
            yield {
                name: `markdown/${exportFileName(row.title, row.id, "md")}`,
                kind: "file",
                size: BigInt(Buffer.byteLength(markdown)),
                mtime: row.updatedAt,
                body: async () => textStream(markdown)
            };
            yield {
                name: `json/${exportFileName(row.title, row.id, "json")}`,
                kind: "file",
                size: BigInt(Buffer.byteLength(json)),
                mtime: row.updatedAt,
                body: async () => textStream(json)
            };
        }
    }
    return createZipStream(sources());
}
