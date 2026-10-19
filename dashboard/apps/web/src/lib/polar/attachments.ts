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
 * Server-only.
 */

import { extname } from "node:path";
import type { UIMessage } from "ai";
import { prisma } from "@polaris/db";
import { chatTarget } from "@/lib/chat/attachments";
import { pipeThenDispose } from "@/lib/drive-stream";
import { driverForTarget, LOCAL_TARGET, safeName, streamFile } from "@/lib/storage-target";
import { POLAR_ATTACHMENT_MAX_BYTES, POLAR_ATTACHMENT_TYPES, polarAttachmentId } from "@/lib/polar/shared";

/** Under POLARIS_DATA_DIR, when the file stays on this server. */
const LOCAL_FOLDER = "polar";
/** Inside whichever storage, legible from a file browser. */
const ROOT = "polaris/polar";
/** Most bytes one turn hands a provider, all files together. */
const TURN_MAX_BYTES = 24 * 1024 * 1024;

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

/** One of this person's files, streamed, or null when it is not theirs. */
export async function readPolarAttachment(
    userId: string,
    id: string
): Promise<{ name: string; mediaType: string; size: number; body: ReadableStream<Uint8Array> } | null> {
    const row = await prisma.polarAttachment.findFirst({
        where: { id, userId },
        select: { name: true, mediaType: true, size: true, connectionId: true, path: true }
    });
    if (!row) return null;
    const driver = await driverForTarget(row.connectionId ?? LOCAL_TARGET, LOCAL_FOLDER);
    let body: ReadableStream<Uint8Array>;
    try {
        body = await driver.readStream(row.path);
    } catch (error) {
        await driver.dispose().catch(() => undefined);
        throw error;
    }
    return { name: row.name, mediaType: row.mediaType, size: row.size, body: pipeThenDispose(body, driver) };
}

/**
 * The messages with every Polar file swapped for its bytes, as a data URL the
 * model can read. A file that is not this person's, or is no longer there, is
 * dropped from the turn. So is any other address: a client does not get to make
 * a provider fetch a URL of its choosing.
 */
export async function inlinePolarFiles(userId: string, messages: readonly UIMessage[]): Promise<UIMessage[]> {
    let budget = TURN_MAX_BYTES;
    const result: UIMessage[] = [];
    for (const message of messages) {
        const parts: UIMessage["parts"] = [];
        for (const part of message.parts) {
            if (part.type !== "file") {
                parts.push(part);
                continue;
            }
            const id = polarAttachmentId(part.url);
            if (!id) continue;
            const file = await readPolarAttachment(userId, id).catch(() => null);
            if (!file) continue;
            if (file.size > budget) {
                await file.body.cancel().catch(() => undefined);
                continue;
            }
            const bytes = new Uint8Array(await new Response(file.body).arrayBuffer());
            budget -= bytes.byteLength;
            parts.push({
                ...part,
                mediaType: file.mediaType,
                url: `data:${file.mediaType};base64,${Buffer.from(bytes).toString("base64")}`
            });
        }
        result.push({ ...message, parts });
    }
    return result;
}
