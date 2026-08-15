/**
 * Files on a message.
 *
 * The bytes go wherever the instance sends uploads, through the same storage
 * targets a profile photo uses - Polaris already knows how to reach a NAS, and
 * nothing that accepts a file needs a second way of writing bytes.
 *
 * The default is deliberately "wherever avatars go" rather than "auto". An
 * operator who has already answered "where do uploads live on this box" has
 * answered it for this too, and making them answer the same question again for
 * every kind of upload is how the two end up disagreeing. Setting the chat's own
 * target overrides it, and from then on the two are independent.
 *
 * Which storage a file went to is recorded on the row, not read back from the
 * setting: pointing chat at a NAS next month must not break every file already
 * written somewhere else.
 */

import { prisma } from "@polaris/db";
import { getSetting, setSetting } from "@/lib/setting-store";
import {
    AUTOMATIC_TARGET,
    LOCAL_TARGET,
    driverForTarget,
    resolveStorageTarget,
    storageTargetOptions,
    type TargetOption,
    type UploadTarget
} from "@/lib/storage-target";

/** Where the chat's own choice is stored. Absent means "follow avatars". */
export const CHAT_TARGET_KEY = "chat.attachments.target";

/** The key the answer falls back to, which is the one most instances have
 *  already answered. */
const AVATAR_TARGET_KEY = "avatars.target";

/** Under POLARIS_DATA_DIR, when the target is this server. */
const LOCAL_FOLDER = "chat";

/** Inside whichever storage, so a NAS shared with everything else stays legible
 *  from a file browser. */
const ATTACHMENT_ROOT = "polaris/chat";

/**
 * The most one file may be.
 *
 * A chat is not a file server: something bigger than this belongs in Drive, with
 * a link to it in the conversation. The ceiling also bounds what one message can
 * cost to render for everybody in the room.
 */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/** How many files ride on one message. */
export const MAX_ATTACHMENTS = 10;

/**
 * What the browser is allowed to show inline.
 *
 * Everything else is a download. An `<img>` pointed at a file somebody uploaded
 * is the browser being asked to interpret bytes from an untrusted source, so the
 * list is the formats that are images and nothing that can carry script - which
 * is why SVG is not on it.
 */
const INLINE_IMAGE = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]);

export function isInlineImage(contentType: string): boolean {
    return INLINE_IMAGE.has(contentType.toLowerCase());
}

export interface ChatStorageSettings {
    /** What is stored: a connection id, `local`, `auto`, or absent for "follow
     *  whatever profile photos use". */
    readonly choice: string | null;
    readonly resolved: UploadTarget;
    /** True when the answer came from the avatars setting rather than this one. */
    readonly followingAvatars: boolean;
    readonly options: TargetOption[];
}

/** What the admin screen shows and edits. */
export async function chatStorageSettings(): Promise<ChatStorageSettings> {
    const choice = await getSetting(CHAT_TARGET_KEY);
    const [resolved, options] = await Promise.all([chatTarget(), storageTargetOptions()]);
    return { choice, resolved, followingAvatars: choice === null, options };
}

export async function setChatStorageTarget(target: string | null): Promise<void> {
    await setSetting(CHAT_TARGET_KEY, target ?? "");
}

/** Where a file written right now would go. */
export async function chatTarget(): Promise<UploadTarget> {
    const choice = await getSetting(CHAT_TARGET_KEY);
    // An empty string is what "follow avatars" is stored as, because the setting
    // store holds strings and deleting a key is not something it offers.
    if (!choice) return resolveStorageTarget(AVATAR_TARGET_KEY);
    return resolveStorageTarget(CHAT_TARGET_KEY);
}

/** One file, as it was stored. */
export interface StoredAttachment {
    readonly name: string;
    readonly size: number;
    readonly contentType: string;
    readonly connectionId: string | null;
    readonly path: string;
}

/**
 * Write one file and say where it went.
 *
 * The stored name is generated rather than taken from the upload: a name from
 * outside is a path traversal waiting to happen, and two people uploading
 * `screenshot.png` must not collide. What they called it is kept on the row and
 * is what the download is served as.
 */
export async function storeAttachment(
    channelId: string,
    file: { name: string; type: string; bytes: Uint8Array }
): Promise<StoredAttachment> {
    if (file.bytes.length > MAX_ATTACHMENT_BYTES) throw new Error("That file is too big");

    const target = await chatTarget();
    const driver = await driverForTarget(target.id, LOCAL_FOLDER);
    const folder = `${ATTACHMENT_ROOT}/${safe(channelId)}`;
    const path = `${folder}/${crypto.randomUUID()}`;

    try {
        await driver.mkdir(folder).catch(() => undefined);
        await driver.writeStream(path, streamOf(file.bytes), {
            mime: file.type || "application/octet-stream",
            size: BigInt(file.bytes.length)
        });
    } finally {
        await driver.dispose().catch(() => undefined);
    }

    return {
        name: file.name.slice(0, 200) || "file",
        size: file.bytes.length,
        contentType: file.type || "application/octet-stream",
        connectionId: target.id === LOCAL_TARGET ? null : target.id,
        path
    };
}

/** Read one back, for the download route. Null when the bytes are gone. */
export async function readAttachment(attachmentId: string): Promise<{
    readonly name: string;
    readonly contentType: string;
    readonly bytes: Uint8Array;
} | null> {
    const row = await prisma.chatAttachment.findUnique({
        where: { id: attachmentId },
        select: { name: true, contentType: true, connectionId: true, path: true }
    });
    if (!row) return null;

    const driver = await driverForTarget(row.connectionId ?? LOCAL_TARGET, LOCAL_FOLDER);
    try {
        const stream = await driver.readStream(row.path);
        // Read through the reader rather than `for await`: a web ReadableStream
        // is only async-iterable in some runtimes, and the driver's return type
        // is the web one.
        const reader = stream.getReader();
        const chunks: Buffer[] = [];
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) chunks.push(Buffer.from(value));
        }
        return { name: row.name, contentType: row.contentType, bytes: Buffer.concat(chunks) };
    } catch {
        // A swept file, a storage target that moved, a NAS that is not answering.
        // The caller turns this into a 404 rather than a 500: from the reader's
        // side those are the same thing.
        return null;
    } finally {
        await driver.dispose().catch(() => undefined);
    }
}

/** Which channel an attachment belongs to, so the download can be authorized
 *  before a single byte is read. */
export async function channelOfAttachment(attachmentId: string): Promise<string | null> {
    const row = await prisma.chatAttachment.findUnique({
        where: { id: attachmentId },
        select: { message: { select: { channelId: true } } }
    });
    return row?.message.channelId ?? null;
}

/** A path segment that cannot be anything but a path segment. */
function safe(value: string): string {
    return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 64) || "unnamed";
}

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(bytes);
            controller.close();
        }
    });
}

export { AUTOMATIC_TARGET, LOCAL_TARGET };
