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
import { keepChannelForReports, keepForReports } from "./report-files";
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
 * Where a file goes when a report is the only thing left holding it.
 *
 * Beside the conversations rather than inside one, and that placement is the
 * whole design. Everything that deletes a conversation's files does it by
 * deleting `polaris/chat/<channel>` whole, and the sweep below removes any
 * folder under that root without a channel to answer for it - so evidence kept
 * anywhere under there would be swept away by exactly the operations it has to
 * survive. Out here, neither can reach it, and neither had to learn about it.
 */
const EVIDENCE_ROOT = "polaris/chat-reports";

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

/**
 * The one document type the browser renders itself.
 *
 * Everything else Polaris previews - a spreadsheet, a document, a slide deck,
 * markdown, source - is read with `fetch` and drawn by Polaris' own code, so it
 * can stay an opaque download and be parsed from those bytes. A PDF is the
 * exception: the viewer for it is the browser's own, and a browser handed
 * `application/octet-stream` under `nosniff` will save the file rather than
 * render it.
 *
 * So a PDF is served as itself, and the headers around it are what make that
 * safe: `nosniff` means it is treated as a PDF and nothing else, and the
 * response's own `Content-Security-Policy` sandboxes it with no sources
 * allowed - so nothing inside it runs, loads, or navigates anywhere.
 *
 * Nothing joins this list without that being true of it. HTML would be stored
 * cross-site scripting; SVG is not an image here for the same reason.
 */
export function isInlineDocument(contentType: string): boolean {
    return baseType(contentType) === "application/pdf";
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
    /** Where the still taken from a video lives, and on which storage. Null for
     *  everything that is not a video. */
    readonly posterPath: string | null;
    readonly posterConnectionId: string | null;
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
    sound?: SoundDetail,
    /**
     * A still the browser took from a video, to draw before anybody plays it.
     *
     * Written beside the file and never instead of it. A failure to write it is
     * not a failure to send the message: the worst case is a list that draws a
     * black rectangle where it would have drawn a frame.
     */
    poster?: Uint8Array | null
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

    const still = poster && poster.length > 0 ? await placePoster(folder, path, poster) : null;

    return {
        name: file.name.slice(0, 200) || "file",
        size: file.bytes.length,
        contentType: file.type || "application/octet-stream",
        connectionId: placed.targetId === LOCAL_TARGET ? null : placed.targetId,
        path,
        posterPath: still?.path ?? null,
        posterConnectionId: still?.connectionId ?? null,
        ...soundOf(sound)
    };
}

/**
 * The biggest a still may be.
 *
 * A JPEG of a screen at 640 pixels across is twenty kilobytes; a hundred is the
 * ceiling on what a browser may claim is a thumbnail. It arrives from a client
 * like everything else here.
 */
const MAX_POSTER_BYTES = 100 * 1024;

/**
 * Write the still beside the file it is of.
 *
 * Beside rather than in a folder of its own, so a conversation's files stay one
 * folder that an operator can find, back up or delete in one go - which is the
 * whole reason the attachments are laid out the way they are.
 *
 * Never fatal. A message with its video and no thumbnail is a message; a message
 * refused because a thumbnail could not be written is a bug.
 */
async function placePoster(
    folder: string,
    path: string,
    bytes: Uint8Array
): Promise<{ path: string; connectionId: string | null } | null> {
    if (bytes.length > MAX_POSTER_BYTES) return null;
    const posterPath = `${path}.poster.jpg`;
    try {
        const placed = await placeFile({
            target: await chatTarget(),
            localFolder: LOCAL_FOLDER,
            folder,
            path: posterPath,
            bytes,
            mime: "image/jpeg",
            what: "thumbnail"
        });
        return {
            path: posterPath,
            connectionId: placed.targetId === LOCAL_TARGET ? null : placed.targetId
        };
    } catch (error) {
        console.error("chat: could not write a thumbnail:", error);
        return null;
    }
}

/** How long one chunk of a download may take before the storage is treated as
 *  gone. Somebody is waiting on a player, so it is shorter than the write. */
const READ_TIMEOUT_MS = 20_000;

/**
 * The still taken from a video, or null when there is none.
 *
 * Its own read rather than part of the attachment's, because the two are asked
 * for at different times and by different screens: a list draws forty
 * thumbnails and none of the files.
 */
export async function readAttachmentPoster(attachmentId: string): Promise<Uint8Array | null> {
    const row = await prisma.chatAttachment.findUnique({
        where: { id: attachmentId },
        select: { posterPath: true, posterConnectionId: true }
    });
    if (!row?.posterPath) return null;
    return readStored(row.posterConnectionId, row.posterPath, `thumbnail ${attachmentId}`);
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

    const bytes = await readStored(row.connectionId, row.path, `attachment ${attachmentId}`);
    return bytes ? { name: row.name, contentType: row.contentType, bytes } : null;
}

/**
 * The bytes at one path, from whichever storage holds them.
 *
 * Twice, with a fresh session the second time.
 *
 * A read can fail for a reason that has nothing to do with the file: a handle
 * another request left open a second ago, a session the server has just reaped,
 * a share reconnecting. One retry turns most of those into a pause nobody
 * notices, and the ones it does not are answered honestly rather than papered
 * over - two attempts, then the truth.
 *
 * Addressed by where the file is rather than by what points at it, because two
 * things point at the same file: the message it was sent on, and a report
 * somebody made about that message.
 *
 * @param what - How to name it in a log line, for the two attempts that fail.
 */
export async function readStored(
    connectionId: string | null,
    path: string,
    what: string
): Promise<Uint8Array | null> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
        const driver = await driverForTarget(connectionId ?? LOCAL_TARGET, LOCAL_FOLDER).catch(
            (error: unknown) => {
                // The storage did not answer, which is a different thing from
                // the file being gone and the only one of the two anybody can
                // do something about.
                if (attempt === 1) {
                    console.error(`chat: the storage holding ${what} could not be opened:`, error);
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
                driver.readStream(path),
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
            return Buffer.concat(chunks);
        } catch (error) {
            // A swept file, a storage target that moved, a NAS that is not
            // answering. The caller turns this into a 410 rather than a 500:
            // from the reader's side those are the same thing.
            //
            // Said out loud on the last attempt. Silently, this is a message
            // with a file on it that nobody can open and nothing anywhere
            // saying why.
            if (attempt === 1) console.error(`chat: could not read ${what} at ${path}:`, error);
        } finally {
            await driver.dispose().catch(() => undefined);
        }
    }
    return null;
}

/**
 * Move a file out from under the message that is about to lose it.
 *
 * A moved file, not a copied one, and that is the point. A report holds the same
 * bytes the message holds - one file, two things pointing at it - so a
 * conversation full of pictures does not cost twice as much because somebody
 * objected to one of them. The arrangement only breaks at one moment: the author
 * deletes the message, and the file goes with it. This is that moment.
 *
 * Written to the storage this instance uses today rather than the one the file
 * is on, because the old one may be a NAS that is being decommissioned - which
 * is a thing that happens to a file nobody has touched in six months, which is
 * what evidence is. The source copy is deleted last and its failure is not
 * fatal: a byte range left behind on an unreachable share is worse than losing
 * the evidence, but only just, and it is the sweep's problem.
 *
 * @returns where it now is, or null if it could not be moved - in which case the
 *   caller leaves the row alone and the file is deleted with the message, which
 *   is the honest outcome rather than a row pointing at nothing.
 */
export async function holdFile(
    from: { connectionId: string | null; path: string },
    folder: string,
    name: string
): Promise<{ connectionId: string | null; path: string } | null> {
    const bytes = await readStored(from.connectionId, from.path, `a reported file at ${from.path}`);
    if (!bytes) return null;

    const into = `${EVIDENCE_ROOT}/${safe(folder)}`;
    const path = `${into}/${safe(name)}`;
    let placed: { targetId: string };
    try {
        placed = await placeFile({
            target: await chatTarget(),
            localFolder: LOCAL_FOLDER,
            folder: into,
            path,
            bytes,
            mime: "application/octet-stream",
            what: "reported file"
        });
    } catch (error) {
        console.error(`chat: a reported file at ${from.path} could not be kept:`, error);
        return null;
    }

    // Only once the new copy exists. The order is what makes this a move that
    // cannot lose the file rather than a delete that usually copies first.
    const driver = await driverForTarget(from.connectionId ?? LOCAL_TARGET, LOCAL_FOLDER).catch(
        () => null
    );
    if (driver) {
        try {
            await driver.delete(from.path).catch(() => undefined);
        } finally {
            await driver.dispose().catch(() => undefined);
        }
    }

    return { connectionId: placed.targetId === LOCAL_TARGET ? null : placed.targetId, path };
}

/** Everything a report was keeping, gone with the report. */
export async function discardEvidence(reportIds: readonly string[]): Promise<void> {
    const folders = [...new Set(reportIds)];
    if (folders.length === 0) return;

    const driver = await driverForTarget((await chatTarget()).id, LOCAL_FOLDER).catch(() => null);
    if (!driver) return;
    try {
        for (const folder of folders) {
            await driver
                .delete(`${EVIDENCE_ROOT}/${safe(folder)}`, { recursive: true })
                .catch(() => undefined);
        }
    } finally {
        await driver.dispose().catch(() => undefined);
    }
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
        select: { id: true, connectionId: true, path: true, posterPath: true, posterConnectionId: true }
    });
    if (files.length === 0) return;

    // Anything a report is holding is moved out from under this first, so that
    // deleting a message somebody objected to does not also delete what they
    // objected to. Nothing is refused and nothing is copied - see
    // `report-files` - and for the overwhelming majority of messages this is one
    // indexed lookup that finds nothing.
    await keepForReports(files.map((file) => file.id));

    await removeStoredFiles([
        ...files,
        // The still goes with the file it is of. Nothing else points at it, and a
        // thumbnail left on a NAS is a disk that only fills up.
        ...files
            .filter((file) => file.posterPath)
            .map((file) => ({ connectionId: file.posterConnectionId, path: file.posterPath! }))
    ]);
}

/**
 * Take a set of stored files off whatever storage each of them is on.
 *
 * One driver per storage rather than one per file, because opening a NAS session
 * for each of ten attachments is ten handshakes for one delete. A file that
 * cannot be removed - a target that has moved, a share that is not answering -
 * does not stop the caller: they are taking something back, and refusing that
 * because a byte range is unreachable helps nobody.
 *
 * The folder goes too when it is the last file in it. A conversation's files
 * live in one folder named after the channel, and without this every
 * conversation that ever carried a picture leaves an empty directory named after
 * a uuid behind it, forever, in somebody's file browser.
 *
 * Shared with the scheduled messages, whose files are written when the message
 * is written and have to be swept when it is taken back - the same bytes in the
 * same folders, and there is no second way to remove them.
 */
export async function removeStoredFiles(
    files: readonly { readonly connectionId: string | null; readonly path: string }[]
): Promise<void> {
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
                        // Never recursive. A delete without this takes the folder
                        // and everything in it - which, between the listing above
                        // and this line, could be a picture somebody has just
                        // sent. The refusal is the outcome to want.
                        await driver.delete(folder, { recursive: false }).catch(() => undefined);
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

    // The whole folder goes below, recursively, so anything a report is holding
    // has to be out of it before that runs. A report outlives the conversation
    // it was made in - it is the instance's record, not the room's.
    await keepChannelForReports(channels);

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
                    // Empty, and asked for as not recursive - which the default
                    // is not. Without it a file that landed between the listing
                    // and this line would be taken with the folder; with it the
                    // delete refuses, which is what was meant all along.
                    await driver
                        .delete(entry.path, { recursive: false })
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
