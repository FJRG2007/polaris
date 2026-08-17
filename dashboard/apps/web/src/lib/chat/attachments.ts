/**
 * Files on a message.
 *
 * The bytes go wherever the instance sends uploads, through the same storage
 * targets a profile photo uses - Polaris already knows how to reach a NAS, and
 * nothing that accepts a file needs a second way of writing bytes.
 *
 * Where they go is this app's own setting, and "work it out" is the default.
 * It used to follow whatever profile photos were set to, which read as one
 * fewer decision and was really a second, invisible one: a screen that says
 * "same as profile photos" makes somebody go and look at another screen to find
 * out what this one does, and moving the photos moved every file in every
 * conversation with them.
 *
 * Which storage a file went to is recorded on the row, not read back from the
 * setting: pointing chat at a NAS next month must not break every file already
 * written somewhere else.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { getSetting, setSetting } from "@/lib/setting-store";
import {
    AUTOMATIC_TARGET,
    LOCAL_TARGET,
    placeFile,
    driverForTarget,
    resolveStorageTarget,
    storageTargetOptions,
    type TargetOption,
    type UploadTarget
} from "@/lib/storage-target";

/** Where the chat's own choice is stored. Absent means "follow avatars". */
export const CHAT_TARGET_KEY = "chat.attachments.target";

/** Under POLARIS_DATA_DIR, when the target is this server. */
const LOCAL_FOLDER = "chat";

/** Inside whichever storage, so a NAS shared with everything else stays legible
 *  from a file browser. */
const ATTACHMENT_ROOT = "polaris/chat";

/**
 * The most one file may be, whatever the rules say.
 *
 * A chat is not a file server: something bigger than this belongs in Drive, with
 * a link to it in the conversation. The admin sets the actual limit per kind of
 * conversation and can only go lower - this is the ceiling, and it is a fact
 * about the code rather than a matter of taste, because a file is held in memory
 * whole on its way in and on its way back out.
 */
export const MAX_ATTACHMENT_BYTES = core.CHAT_ATTACHMENT_CEILING_MIB * 1024 * 1024;

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
    return INLINE_IMAGE.has(baseType(contentType));
}

/**
 * What may be served as the sound or the picture-with-sound that it is.
 *
 * A voice message is played by an `<audio>` element pointed at the download
 * route, and a browser will not play what it is handed as
 * `application/octet-stream` - `nosniff` is set, deliberately, so it may not
 * guess either. So the media types Polaris draws a player for are served as
 * themselves, and everything not on this list keeps being an opaque download.
 *
 * A fixed list rather than `startsWith("audio/")`, because the type comes from
 * an upload: this decides what a browser is told to do with somebody else's
 * bytes, and the safe answer for anything unrecognised is "save it".
 */
const PLAYABLE = new Set([
    "audio/webm",
    "audio/ogg",
    "audio/mpeg",
    "audio/mp4",
    "audio/aac",
    "audio/wav",
    "audio/x-wav",
    "audio/flac",
    "video/mp4",
    "video/webm",
    "video/ogg"
]);

export function isPlayableMedia(contentType: string): boolean {
    return PLAYABLE.has(baseType(contentType));
}

/** The type without its parameters. A recording arrives as
 *  `audio/webm;codecs=opus`, and the codec is not part of the question. */
function baseType(contentType: string): string {
    return (contentType.split(";")[0] ?? "").trim().toLowerCase();
}

export interface ChatStorageSettings {
    /** What is stored: a connection id, `local`, or `auto`. */
    readonly choice: string;
    readonly resolved: UploadTarget;
    readonly options: TargetOption[];
}

/** What the admin screen shows and edits. */
export async function chatStorageSettings(): Promise<ChatStorageSettings> {
    const [choice, resolved, options] = await Promise.all([
        getSetting(CHAT_TARGET_KEY),
        chatTarget(),
        storageTargetOptions()
    ]);
    return { choice: choice || AUTOMATIC_TARGET, resolved, options };
}

export async function setChatStorageTarget(target: string): Promise<void> {
    await setSetting(CHAT_TARGET_KEY, target);
}

/** Where a file written right now would go. Unset means "work it out", which is
 *  a NAS if the instance has one and this server otherwise. */
export async function chatTarget(): Promise<UploadTarget> {
    return resolveStorageTarget(CHAT_TARGET_KEY);
}

/** One file, as it was stored. */
export interface StoredAttachment {
    readonly name: string;
    readonly size: number;
    readonly contentType: string;
    readonly connectionId: string | null;
    readonly path: string;
    /** How long it plays for, when the browser that made it knew. */
    readonly durationMs: number | null;
    /** Its shape, one digit a bar. */
    readonly waveform: string | null;
}

/**
 * What the browser that recorded something says about the sound of it.
 *
 * Taken from the client and therefore checked here rather than trusted: a
 * duration is clamped to something a recording can be, and a waveform is digits
 * or it is nothing. Neither is ever used for a decision - they are drawn - but
 * "only drawn" is exactly how a string from outside ends up in a page.
 */
export interface SoundDetail {
    readonly durationMs?: unknown;
    readonly waveform?: unknown;
}

/** The longest a duration may claim to be: the recording ceiling with room to
 *  spare, so a wrong number cannot draw a bar an hour long. */
const MAX_DURATION_MS = 60 * 60 * 1000;

/** How many bars a waveform may carry. The recorder draws forty-eight; the
 *  ceiling is what is accepted, not what is asked for. */
const MAX_WAVEFORM_BARS = 64;

function soundOf(detail: SoundDetail | undefined): {
    durationMs: number | null;
    waveform: string | null;
} {
    const claimed = Number(detail?.durationMs);
    const durationMs =
        Number.isFinite(claimed) && claimed > 0
            ? Math.min(Math.round(claimed), MAX_DURATION_MS)
            : null;

    const shape = typeof detail?.waveform === "string" ? detail.waveform : "";
    const waveform =
        shape.length > 0 && shape.length <= MAX_WAVEFORM_BARS && /^[0-9]+$/.test(shape)
            ? shape
            : null;
    return { durationMs, waveform };
}

/**
 * Write one file and say where it went.
 *
 * The stored name is generated rather than taken from the upload: a name from
 * outside is a path traversal waiting to happen, and two people uploading
 * `screenshot.png` must not collide. What they called it is kept on the row and
 * is what the download is served as.
 */
/**
 * A file that went to storage and did not come back.
 *
 * Its own error because the caller has to say something different about it: not
 * "that could not be sent", which reads as a bug in Polaris, but which storage
 * took the bytes and what it said when they were asked for again.
 */
export class AttachmentStorageError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "AttachmentStorageError";
    }
}

export async function storeAttachment(
    channelId: string,
    file: { name: string; type: string; bytes: Uint8Array },
    /** What the browser said about the sound of it, for a recording. */
    sound?: SoundDetail
): Promise<StoredAttachment> {
    if (file.bytes.length > MAX_ATTACHMENT_BYTES) throw new Error("That file is too big");

    const folder = `${ATTACHMENT_ROOT}/${safe(channelId)}`;
    const path = `${folder}/${crypto.randomUUID()}`;

    // Written, proved readable, and moved to this server if the storage this
    // instance points at will not keep it - all of which is `placeFile`, and all
    // of which used to be here in a copy that a profile photo did not have.
    let placed: { targetId: string };
    try {
        placed = await placeFile({
            target: await chatTarget(),
            localFolder: LOCAL_FOLDER,
            folder,
            path,
            bytes: file.bytes,
            mime: file.type || "application/octet-stream",
            what: "file"
        });
    } catch (error) {
        // Said as what it is. "That could not be sent" for a storage that took
        // the file and lost it sends whoever reads it looking at the browser, at
        // the network and at the message - anywhere but at the disk.
        throw new AttachmentStorageError(reason(error));
    }

    return {
        name: file.name.slice(0, 200) || "file",
        size: file.bytes.length,
        contentType: file.type || "application/octet-stream",
        connectionId: placed.targetId === LOCAL_TARGET ? null : placed.targetId,
        path,
        ...soundOf(sound)
    };
}

/** How long one chunk of a download may take before the storage is treated as
 *  gone. Somebody is waiting on a player, so it is shorter than the write. */
const READ_TIMEOUT_MS = 20_000;

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

    // Twice, with a fresh session the second time.
    //
    // A read can fail for a reason that has nothing to do with the file: a
    // handle another request left open a second ago, a session the server has
    // just reaped, a share reconnecting. One retry turns most of those into a
    // pause nobody notices, and the ones it does not are answered honestly
    // rather than papered over - two attempts, then the truth.
    for (let attempt = 0; attempt < 2; attempt += 1) {
        const driver = await driverForTarget(row.connectionId ?? LOCAL_TARGET, LOCAL_FOLDER).catch(
            (error: unknown) => {
                // The storage did not answer, which is a different thing from
                // the file being gone and the only one of the two anybody can
                // do something about.
                if (attempt === 1) {
                    console.error(
                        `chat: the storage holding attachment ${attachmentId} could not be opened:`,
                        error
                    );
                }
                return null;
            }
        );
        if (!driver) continue;
        try {
            // Bounded, like the write. A storage that refuses is answered with a
            // 410 in a moment; a storage that goes quiet would otherwise hold
            // the request until the platform gives up on it, which is a player
            // that spins forever with nothing anywhere saying why.
            const stream = await core.withTimeout(
                driver.readStream(row.path),
                READ_TIMEOUT_MS,
                "the storage did not open the file"
            );
            // Read through the reader rather than `for await`: a web
            // ReadableStream is only async-iterable in some runtimes, and the
            // driver's return type is the web one.
            const reader = stream.getReader();
            const chunks: Buffer[] = [];
            for (;;) {
                const { done, value } = await core.withTimeout(
                    reader.read(),
                    READ_TIMEOUT_MS,
                    "the storage stopped part-way through the file"
                );
                if (done) break;
                if (value) chunks.push(Buffer.from(value));
            }
            return { name: row.name, contentType: row.contentType, bytes: Buffer.concat(chunks) };
        } catch (error) {
            // A swept file, a storage target that moved, a NAS that is not
            // answering. The caller turns this into a 410 rather than a 500:
            // from the reader's side those are the same thing.
            //
            // Said out loud on the last attempt. Silently, this is a message
            // with a file on it that nobody can open and nothing anywhere
            // saying why.
            if (attempt === 1) {
                console.error(
                    `chat: could not read attachment ${attachmentId} at ${row.path}:`,
                    error
                );
            }
        } finally {
            await driver.dispose().catch(() => undefined);
        }
    }
    return null;
}

/**
 * Delete the files on a message from wherever they were written.
 *
 * Every route out of a message goes through here - taken back without trace, or
 * left as a tombstone, which carries no files either. The rows cascade with the
 * message; this is the part the database cannot do, and without it deleting a
 * message would mean the words are gone and the photograph is still on the NAS.
 *
 * One driver per storage rather than one per file, because opening a NAS session
 * for each of ten attachments is ten handshakes for one delete. A file that
 * cannot be removed - a target that has moved, a share that is not answering -
 * does not stop the deletion: the caller is taking a message back, and refusing
 * that because a byte range is unreachable helps nobody.
 *
 * The folder goes too when it is the last file in it. A conversation's files live
 * in one folder named after the channel, and without this every conversation that
 * ever carried a picture leaves an empty directory named after a uuid behind it,
 * forever, in somebody's file browser.
 */
export async function discardAttachments(messageId: string): Promise<void> {
    const files = await prisma.chatAttachment.findMany({
        where: { messageId },
        select: { connectionId: true, path: true }
    });
    if (files.length === 0) return;

    const byTarget = new Map<string, string[]>();
    for (const file of files) {
        const target = file.connectionId ?? LOCAL_TARGET;
        byTarget.set(target, [...(byTarget.get(target) ?? []), file.path]);
    }

    await Promise.all(
        [...byTarget].map(async ([target, paths]) => {
            const driver = await driverForTarget(target, LOCAL_FOLDER).catch(() => null);
            if (!driver) return;
            try {
                for (const path of paths) await driver.delete(path).catch(() => undefined);
                for (const folder of new Set(paths.map(folderOf))) {
                    if (!folder) continue;
                    const listed = await driver.list(folder).catch(() => null);
                    if (listed && listed.entries.length === 0) {
                        await driver.delete(folder).catch(() => undefined);
                    }
                }
            } finally {
                await driver.dispose().catch(() => undefined);
            }
        })
    );
}

/**
 * Everything a conversation ever stored, gone with the conversation.
 *
 * Deleting a channel used to take the rows and leave the bytes: the rows cascade
 * away, and with them the only record of where the files were, so nothing could
 * ever find them again. On an instance with a NAS behind it that is a disk that
 * only fills up.
 *
 * One recursive delete per storage rather than a walk of the rows. A channel's
 * files are all in one folder named after it, so this is one call whether the
 * channel carried two files or two thousand - which is the difference between a
 * delete and a job.
 *
 * Which storages to ask is read from the rows while they still exist. A file
 * written when the instance pointed at a NAS is on that NAS whatever the setting
 * says today, and the current target is asked as well so a folder left behind by
 * a write that failed goes with it.
 */
export async function discardChannelFiles(channelIds: readonly string[]): Promise<void> {
    const channels = [...new Set(channelIds)];
    if (channels.length === 0) return;

    const stored = await prisma.chatAttachment.findMany({
        where: { message: { channelId: { in: channels } } },
        select: { connectionId: true },
        distinct: ["connectionId"]
    });
    const targets = new Set(stored.map((row) => row.connectionId ?? LOCAL_TARGET));
    targets.add((await chatTarget()).id);

    await Promise.all(
        [...targets].map(async (target) => {
            const driver = await driverForTarget(target, LOCAL_FOLDER).catch(() => null);
            if (!driver) return;
            try {
                for (const channelId of channels) {
                    await driver
                        .delete(`${ATTACHMENT_ROOT}/${safe(channelId)}`, { recursive: true })
                        .catch(() => undefined);
                }
            } finally {
                await driver.dispose().catch(() => undefined);
            }
        })
    );
}

/**
 * Folders under the chat's root that no conversation answers for.
 *
 * Housekeeping for what earlier builds left behind: a conversation deleted
 * before Polaris knew to take its files with it left the whole folder, and a
 * message deleted one at a time left an empty directory named after a uuid.
 * Neither is reachable from anywhere in Polaris, and neither will ever be looked
 * at again.
 *
 * Deliberately narrow about what it removes. A folder goes when the conversation
 * it is named after no longer exists, or when it is empty - never because
 * nothing points at the files inside it, which would turn a bug in the rows into
 * a way of deleting somebody's pictures.
 *
 * Every storage the instance has ever written chat files to, as far as the rows
 * still say, plus the one it writes to now.
 */
export async function tidyChatStorage(): Promise<{ removed: number; failed: number }> {
    const [stored, channels, current] = await Promise.all([
        prisma.chatAttachment.findMany({
            select: { connectionId: true },
            distinct: ["connectionId"]
        }),
        prisma.chatChannel.findMany({ select: { id: true } }),
        chatTarget()
    ]);
    const live = new Set(channels.map((channel) => safe(channel.id)));
    const targets = new Set(stored.map((row) => row.connectionId ?? LOCAL_TARGET));
    targets.add(current.id);

    let removed = 0;
    let failed = 0;

    for (const target of targets) {
        const driver = await driverForTarget(target, LOCAL_FOLDER).catch(() => null);
        if (!driver) {
            failed += 1;
            continue;
        }
        try {
            // Paged, because the root holds one folder per conversation and an
            // instance with thousands of them would otherwise be tidied down to
            // whatever the first page happened to hold.
            let cursor: string | undefined;
            do {
                const page = await driver
                    .list(ATTACHMENT_ROOT, cursor ? { cursor } : undefined)
                    .catch(() => null);
                if (!page) break;
                cursor = page.nextCursor;

                for (const entry of page.entries) {
                    if (entry.kind !== "dir") continue;
                    if (!live.has(entry.name)) {
                        // The conversation is gone: so is everything in it.
                        await driver
                            .delete(entry.path, { recursive: true })
                            .then(() => {
                                removed += 1;
                            })
                            .catch(() => {
                                failed += 1;
                            });
                        continue;
                    }
                    const inside = await driver.list(entry.path).catch(() => null);
                    if (!inside || inside.entries.length > 0) continue;
                    // Empty, and not recursive: a file that landed between the
                    // listing and this makes the delete fail, which is the
                    // outcome to want.
                    await driver
                        .delete(entry.path)
                        .then(() => {
                            removed += 1;
                        })
                        .catch(() => undefined);
                }
            } while (cursor);
        } finally {
            await driver.dispose().catch(() => undefined);
        }
    }

    return { removed, failed };
}

/** The folder a stored path sits in, or empty for one that has none. */
function folderOf(path: string): string {
    const cut = path.lastIndexOf("/");
    return cut > 0 ? path.slice(0, cut) : "";
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

/**
 * Why one attachment could not be read, for an administrator.
 *
 * Asked at the moment somebody hits the failure rather than left in a log they
 * would have to go and find. It answers the question the row cannot: the file
 * was written - a message exists and it was verified on the way in - so what is
 * different now.
 *
 * The two answers it is really looking for:
 *
 * - the folder is empty, or missing. The bytes went somewhere that does not keep
 *   them: a directory inside a container that a deploy replaced, or a second
 *   copy of Polaris whose disk is not this one - an upload served by one and
 *   asked for from the other looks exactly like this.
 * - the file is there and the read failed anyway: permissions, or storage that
 *   answers a stat and not a read.
 *
 * The host is in it because it is what tells those two apart when there is more
 * than one process answering.
 */
export async function diagnoseAttachment(attachmentId: string): Promise<string> {
    const row = await prisma.chatAttachment.findUnique({
        where: { id: attachmentId },
        select: { connectionId: true, path: true, size: true, createdAt: true }
    });
    if (!row) return "There is no row for that attachment.";

    const { hostname } = await import("node:os");
    const where = row.connectionId ? `connection ${row.connectionId}` : "this server";
    const head = `${row.path} (${row.size} bytes, written ${row.createdAt.toISOString()}) on ${where}, asked for by ${hostname()}`;

    const driver = await driverForTarget(row.connectionId ?? LOCAL_TARGET, LOCAL_FOLDER).catch(
        () => null
    );
    if (!driver) return `${head}: that storage could not be opened at all.`;

    try {
        const folder = row.path.slice(0, row.path.lastIndexOf("/"));
        const listed = await driver.list(folder).catch(() => null);
        if (!listed) {
            return `${head}: its folder is not there. Whatever was written to this storage is not on it any more - a directory inside a container that a deploy replaced, or a second copy of Polaris whose disk is not this one.`;
        }
        const held = listed.entries.length;
        const stat = await driver.stat(row.path).catch((error: unknown) => reason(error));
        if (typeof stat === "string") {
            return `${head}: the folder holds ${held} file(s) and this one cannot even be stat'd: ${stat}`;
        }

        // The read itself, since that is the thing that failed. A file that
        // stats and will not open is a lock or a permission, and the storage's
        // own words for it are the whole answer.
        const opened = await driver
            .readStream(row.path)
            .then(async (stream) => {
                const reader = stream.getReader();
                try {
                    await reader.read();
                    return "";
                } finally {
                    await reader.cancel().catch(() => undefined);
                }
            })
            .catch((error: unknown) => reason(error) || "no reason given");
        return opened
            ? `${head}: the file is there (${Number(stat.size)} bytes) and opening it for reading fails: ${opened}`
            : `${head}: the file is there (${Number(stat.size)} bytes) and reads fine now - whatever refused it has passed.`;
    } finally {
        await driver.dispose().catch(() => undefined);
    }
}

/** Whatever a driver threw, as a line somebody can act on. */
function reason(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** A path segment that cannot be anything but a path segment. */
function safe(value: string): string {
    return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 64) || "unnamed";
}

export { AUTOMATIC_TARGET, LOCAL_TARGET };
