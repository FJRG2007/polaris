/**
 * Pictures and files somebody hands Polar.
 *
 * Stored where chat uploads go (`chatTarget()`), through the same `streamFile`
 * every other upload uses, so a NAS that is away falls back to this server and
 * the row records where the bytes really landed. A message names a file by its
 * own route, `/api/polar/attachments/<id>`; the chat route swaps that for the
 * bytes when the turn is sent, so no provider is ever asked to fetch from here.
 *
 * Every read names the owner: an id from somebody else's message reads as a
 * file that does not exist.
 *
 * A file belongs to the thread whose saved message first carries it and is
 * deleted with that thread. One that never reaches a saved message - removed
 * from the composer, or left there when the tab closed - is swept after a day.
 *
 * Server-only.
 */

import { extname } from "node:path";
import type { UIMessage } from "ai";
import { prisma, Prisma } from "@polaris/db";
import { chatTarget, removeStoredFiles } from "@/lib/chat/attachments";
import { pipeThenDispose } from "@/lib/drive-stream";
import { driverForTarget, LOCAL_TARGET, safeName, streamFile } from "@/lib/storage-target";
import {
    POLAR_ATTACHMENT_MAX_BYTES,
    POLAR_ATTACHMENT_TYPES,
    polarAttachmentId
} from "@/lib/polar/shared";

/** Under POLARIS_DATA_DIR, when the file stays on this server. */
const LOCAL_FOLDER = "polar";
/** Inside whichever storage, legible from a file browser. */
const ROOT = "polaris/polar";
/** Most bytes one turn hands a provider, all files together. */
const TURN_MAX_BYTES = 24 * 1024 * 1024;
/** How long a file no saved message carries is kept. */
const UNSENT_TTL_MS = 24 * 60 * 60 * 1000;

export { POLAR_ATTACHMENT_MAX_BYTES };

export interface PolarAttachmentView {
    id: string;
    url: string;
    filename: string;
    mediaType: string;
    size: number;
}

/** The base type of a Content-Type header, or null when Polar does not take it. */
export function acceptedType(contentType: string | null): string | null {
    const base = (contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
    return (POLAR_ATTACHMENT_TYPES as readonly string[]).includes(base) ? base : null;
}

export async function storePolarAttachment(input: {
    userId: string;
    name: string;
    mediaType: string;
    bytes: Uint8Array;
}): Promise<PolarAttachmentView> {
    const name = safeName(input.name) || "file";
    const folder = `${ROOT}/${input.userId}`;
    const path = `${folder}/${crypto.randomUUID()}${extname(name)}`;
    const placed = await streamFile({
        target: await chatTarget(),
        localFolder: LOCAL_FOLDER,
        folder,
        path,
        body: new Blob([input.bytes]).stream(),
        mime: input.mediaType,
        declared: input.bytes.byteLength,
        what: "Polar attachment"
    });
    const row = await prisma.polarAttachment.create({
        data: {
            userId: input.userId,
            name,
            mediaType: input.mediaType,
            size: placed.size || input.bytes.byteLength,
            connectionId: placed.targetId === LOCAL_TARGET ? null : placed.targetId,
            path
        },
        select: { id: true, name: true, mediaType: true, size: true }
    });
    return {
        id: row.id,
        url: `/api/polar/attachments/${row.id}`,
        filename: row.name,
        mediaType: row.mediaType,
        size: row.size
    };
}

type StoredRow = {
    name: string;
    mediaType: string;
    size: number;
    connectionId: string | null;
    path: string;
};

const STORED_ROW = {
    name: true,
    mediaType: true,
    size: true,
    connectionId: true,
    path: true
} as const;

/** One of this person's files, streamed, or null when it is not theirs. */
export async function readPolarAttachment(
    userId: string,
    id: string
): Promise<{
    name: string;
    mediaType: string;
    size: number;
    body: ReadableStream<Uint8Array>;
} | null> {
    const row = await prisma.polarAttachment.findFirst({
        where: { id, userId },
        select: STORED_ROW
    });
    return row ? openStored(row) : null;
}

async function openStored(
    row: StoredRow
): Promise<{ name: string; mediaType: string; size: number; body: ReadableStream<Uint8Array> }> {
    const driver = await driverForTarget(row.connectionId ?? LOCAL_TARGET, LOCAL_FOLDER);
    let body: ReadableStream<Uint8Array>;
    try {
        body = await driver.readStream(row.path);
    } catch (error) {
        await driver.dispose().catch(() => undefined);
        throw error;
    }
    return {
        name: row.name,
        mediaType: row.mediaType,
        size: row.size,
        body: pipeThenDispose(body, driver)
    };
}

/** The ids of Polar's own files a message carries. */
function attachmentIds(message: UIMessage): string[] {
    return message.parts.flatMap((part) => {
        if (part.type !== "file") return [];
        const id = polarAttachmentId(part.url);
        return id ? [id] : [];
    });
}

/**
 * The messages with every Polar file swapped for its bytes, as a data URL the
 * model can read. A file that is not this person's, or is no longer there, is
 * dropped from the turn. So is any other address: a client does not get to make
 * a provider fetch a URL of its choosing.
 *
 * The budget is spent from the newest message back, so what was just attached
 * always goes, and an older file that no longer fits is left out without being
 * read from storage at all.
 */
/** Most characters of one document's text a turn carries. */
const TEXT_MAX_CHARS = 100_000;

const DOCUMENT_TYPES = new Set([
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation"
]);

/** What the chosen model reads, from the catalogue. `inputs` empty is unknown:
 *  then only the older `attachment` flag says it takes pictures. */
export interface ModelReads {
    inputs: readonly string[];
    attachment: boolean;
}

/**
 * How a file reaches the model: as the file itself when the model reads that
 * kind (a picture to a model that sees, a PDF to one whose catalogue entry lists
 * "pdf"), otherwise as the text taken out of it. Plain text always goes as text:
 * every model reads that, and not every provider takes a text file part.
 */
export function fileRoute(mediaType: string, reads: ModelReads): "file" | "text" {
    if (mediaType.startsWith("image/")) {
        return reads.inputs.includes("image") || (reads.inputs.length === 0 && reads.attachment)
            ? "file"
            : "text";
    }
    if (mediaType === "application/pdf" && reads.inputs.includes("pdf")) return "file";
    return "text";
}

/** The text of a document, bounded, or null when none can be taken out. */
async function documentText(mediaType: string, bytes: Uint8Array): Promise<string | null> {
    let text: string;
    if (mediaType.startsWith("text/") || mediaType === "application/json") {
        text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    } else if (DOCUMENT_TYPES.has(mediaType)) {
        const parse = await import("@polaris/file-parse");
        const read =
            mediaType === "application/pdf"
                ? parse.pdfToText
                : mediaType.includes("wordprocessingml")
                  ? parse.docxToText
                  : mediaType.includes("spreadsheetml")
                    ? parse.xlsxToText
                    : parse.pptxToText;
        text = await read(bytes).catch(() => "");
    } else {
        return null;
    }
    text = text.trim();
    if (!text) return null;
    return text.length > TEXT_MAX_CHARS ? `${text.slice(0, TEXT_MAX_CHARS)}
[...]` : text;
}

/** Everything the model may read: pictures only, as before this was known. */
const READS_PICTURES: ModelReads = { inputs: [], attachment: true };

export async function inlinePolarFiles(
    userId: string,
    messages: readonly UIMessage[],
    reads: ModelReads = READS_PICTURES,
    /** Filled with the names of the newest message's files the model can
     *  neither read as files nor be given the text of. */
    unreadable: string[] = []
): Promise<UIMessage[]> {
    const ids = [...new Set(messages.flatMap(attachmentIds))];
    const rows = ids.length
        ? await prisma.polarAttachment.findMany({
              where: { id: { in: ids }, userId },
              select: { id: true, ...STORED_ROW }
          })
        : [];
    const stored = new Map(rows.map((row) => [row.id, row]));
    let budget = TURN_MAX_BYTES;
    const result: UIMessage[] = [];
    const newest = messages.at(-1);
    for (const message of [...messages].reverse()) {
        const parts: UIMessage["parts"] = [];
        for (const part of message.parts) {
            if (part.type !== "file") {
                parts.push(part);
                continue;
            }
            const id = polarAttachmentId(part.url);
            const row = id ? stored.get(id) : undefined;
            if (!row || row.size > budget) continue;
            const file = await openStored(row).catch(() => null);
            if (!file) continue;
            const bytes = new Uint8Array(await new Response(file.body).arrayBuffer());
            if (bytes.byteLength > budget) continue;
            budget -= bytes.byteLength;
            if (fileRoute(file.mediaType, reads) === "file") {
                parts.push({
                    ...part,
                    mediaType: file.mediaType,
                    url: `data:${file.mediaType};base64,${Buffer.from(bytes).toString("base64")}`
                });
                continue;
            }
            const name = part.filename ?? "file";
            const text = await documentText(file.mediaType, bytes).catch(() => null);
            if (text === null) {
                if (message === newest) unreadable.push(name);
                continue;
            }
            // Fenced as the file's contents: data to read, not instructions.
            parts.push({
                type: "text",
                text: `<file name=${JSON.stringify(name)} type=${JSON.stringify(file.mediaType)}>
${text}
</file>`
            });
        }
        result.push({ ...message, parts });
    }
    return result.reverse();
}

/** The files saved messages carry become their thread's, once. */
export async function linkPolarAttachments(
    userId: string,
    threadId: string,
    messages: readonly UIMessage[]
): Promise<void> {
    const ids = [...new Set(messages.flatMap(attachmentIds))];
    if (ids.length === 0) return;
    await prisma.polarAttachment.updateMany({
        where: { id: { in: ids }, userId, threadId: null },
        data: { threadId }
    });
}

export type PolarStoredFile = { id: string; connectionId: string | null; path: string };

/** This person's files in one thread, to discard once the thread is gone. */
export function threadAttachments(userId: string, threadId: string): Promise<PolarStoredFile[]> {
    return prisma.polarAttachment.findMany({
        where: { userId, threadId },
        select: { id: true, connectionId: true, path: true }
    });
}

/**
 * The files of a thread about to go that no other chat of this person's still
 * carries. One a branch still names moves to the branch instead, so deleting
 * the original does not leave the branch with a broken file.
 */
export async function keepSharedAttachments(
    userId: string,
    threadId: string,
    files: readonly PolarStoredFile[]
): Promise<PolarStoredFile[]> {
    if (files.length === 0) return [];
    const carried = await prisma.$queryRaw<{ id: string; threadId: string }[]>(Prisma.sql`
        SELECT DISTINCT ON (a.id) a.id, m."threadId"::text AS "threadId"
        FROM unnest(${files.map((file) => file.id)}::text[]) AS a(id)
        JOIN "PolarMessage" AS m ON m."parts"::text LIKE '%/api/polar/attachments/' || a.id || '%'
        JOIN "PolarThread" AS t ON t."id" = m."threadId"
        WHERE t."userId" = ${userId}::uuid AND m."threadId" <> ${threadId}::uuid
        ORDER BY a.id, m."createdAt" ASC
    `);
    for (const row of carried) {
        await prisma.polarAttachment.updateMany({
            where: { id: row.id, userId },
            data: { threadId: row.threadId }
        });
    }
    const moved = new Set(carried.map((row) => row.id));
    return files.filter((file) => !moved.has(file.id));
}

/** Rows first, bytes second: bytes without a row only cost disk. */
export async function discardPolarAttachments(files: readonly PolarStoredFile[]): Promise<void> {
    if (files.length === 0) return;
    await prisma.polarAttachment.deleteMany({
        where: { id: { in: files.map((file) => file.id) } }
    });
    await removeStoredFiles(files, LOCAL_FOLDER).catch(() => undefined);
}

/** A file taken out of the composer before it was sent. False when it is not
 *  this person's, or a saved message already carries it. */
export async function removeUnsentAttachment(userId: string, id: string): Promise<boolean> {
    const row = await prisma.polarAttachment.findFirst({
        where: { id, userId, threadId: null },
        select: { id: true, connectionId: true, path: true }
    });
    if (!row) return false;
    await discardPolarAttachments([row]);
    return true;
}

/** Files no saved message carries, a day after they were uploaded. */
export async function sweepUnsentPolarAttachments(
    olderThanMs: number = UNSENT_TTL_MS
): Promise<{ swept: number }> {
    const stale = await prisma.polarAttachment.findMany({
        where: { threadId: null, createdAt: { lt: new Date(Date.now() - olderThanMs) } },
        select: { id: true, connectionId: true, path: true },
        take: 500
    });
    await discardPolarAttachments(stale);
    return { swept: stale.length };
}
