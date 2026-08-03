/**
 * The face an account shows, and where a photo of it is kept.
 *
 * Three answers, in order, and the first one that exists wins:
 *
 *   1. a photo the person uploaded
 *   2. whatever Gravatar has for the address they sign in with
 *   3. their initials, drawn by the client
 *
 * Gravatar is asked by Polaris, never by the browser. A page that pointed an
 * <img> at gravatar.com would put a hash of every colleague's email address into
 * the markup and tell Automattic who is looking at whom, which is a lot to give
 * away for a picture. Asking from the server costs one request per address per
 * day and gives away only that this instance exists. An administrator who does
 * not want even that turns it off.
 *
 * Where uploaded photos are written is `storage-target`'s decision, the same one
 * task attachments make and separately settable: a photo is read constantly and
 * weighs nothing, so an instance may reasonably want it on its own disk while
 * the big attachments go to the NAS.
 */

import { prisma } from "@polaris/db";
import { createHash } from "node:crypto";
import { getSetting, setSetting } from "@/lib/setting-store";
import {
    AUTOMATIC_TARGET,
    driverForTarget,
    LOCAL_TARGET,
    resolveStorageTarget,
    safeName,
    storageTargetOptions,
    type TargetOption,
    type UploadTarget
} from "@/lib/storage-target";

/** Where profile photos go: a storage connection's id, `local`, or `auto`. */
const AVATAR_TARGET_KEY = "avatars.target";
/** Whether an address with no uploaded photo may be looked up on Gravatar. */
const AVATAR_GRAVATAR_KEY = "avatars.gravatar";

/** The folder under POLARIS_DATA_DIR used when photos stay on this server. */
const LOCAL_FOLDER = "avatars";

/** One reserved folder, so a NAS owner can find, move or back up every profile
 *  photo at once instead of hunting them through the uploads tree. */
const AVATAR_ROOT = "polaris/avatars";

/**
 * 2 MB. Well past anything the browser sends - it downsizes to a square before
 * uploading - and low enough that a hand-rolled request cannot park a poster on
 * the disk. Not a setting: nobody has a reason to want a bigger profile photo.
 */
export const MAX_AVATAR_BYTES = 2 * 1024 * 1024;

/**
 * What a profile photo may be.
 *
 * SVG is absent on purpose and must stay absent: it is a document, it can carry
 * script, and it would be served from Polaris's own origin. The three raster
 * formats every browser writes cover everything anybody would upload.
 */
const ALLOWED_MIME = new Map<string, string>([
    ["image/png", ".png"],
    ["image/jpeg", ".jpg"],
    ["image/webp", ".webp"],
    ["image/gif", ".gif"]
]);

/**
 * What the bytes actually are, ignoring what the request claimed.
 *
 * A declared content type is a client's word for it, and the type a file is
 * served back as decides what a browser will do with it. So the answer comes
 * from the first bytes instead, and anything unrecognised is refused rather than
 * stored and worried about later.
 */
export function sniffImageMime(bytes: Uint8Array): string | null {
    const starts = (...signature: number[]) => signature.every((byte, index) => bytes[index] === byte);
    if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
    if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
    if (starts(0x47, 0x49, 0x46, 0x38)) return "image/gif";
    // RIFF....WEBP
    if (starts(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42) {
        return "image/webp";
    }
    return null;
}

export interface AvatarSettings {
    /** What is stored: a connection id, `local`, or `auto`. */
    readonly choice: string;
    /** What that currently resolves to. */
    readonly resolved: UploadTarget;
    readonly gravatar: boolean;
    readonly options: TargetOption[];
}

/** Whether this instance may look an address up on Gravatar. On unless somebody
 *  turned it off: a fresh install should show the faces people already have. */
async function gravatarEnabled(): Promise<boolean> {
    return (await getSetting(AVATAR_GRAVATAR_KEY)) !== "off";
}

/** What the settings screen shows and edits. */
export async function avatarSettings(): Promise<AvatarSettings> {
    const [choice, resolved, gravatar, options] = await Promise.all([
        getSetting(AVATAR_TARGET_KEY),
        resolveStorageTarget(AVATAR_TARGET_KEY),
        gravatarEnabled(),
        storageTargetOptions()
    ]);
    return { choice: choice ?? AUTOMATIC_TARGET, resolved, gravatar, options };
}

export async function setAvatarSettings(input: { target: string; gravatar: boolean }): Promise<void> {
    await setSetting(AVATAR_TARGET_KEY, input.target);
    await setSetting(AVATAR_GRAVATAR_KEY, input.gravatar ? "on" : "off");
}

// ---------------------------------------------------------------------------
// The photo somebody uploaded
// ---------------------------------------------------------------------------

/**
 * Replace an account's photo.
 *
 * The old file is removed after the new row is written rather than before: a
 * failed upload that has already deleted the previous photo leaves the person
 * worse off than when they started.
 */
export async function storeAvatar(userId: string, bytes: Uint8Array, mime: string): Promise<void> {
    const extension = ALLOWED_MIME.get(mime);
    if (!extension) throw new Error("That kind of image is not accepted");

    const previous = await prisma.userAvatar.findUnique({ where: { userId } });
    const target = await resolveStorageTarget(AVATAR_TARGET_KEY);
    const driver = await driverForTarget(target.id, LOCAL_FOLDER);
    // A name of its own rather than the user id: a photo replaced while another
    // browser still has the old one cached must not be served the new bytes
    // under the old name, and a name cannot escape the folder this way either.
    const path = `${AVATAR_ROOT}/${safeName(userId)}-${crypto.randomUUID()}${extension}`;

    try {
        await driver.mkdir(AVATAR_ROOT).catch(() => undefined);
        await driver.writeStream(path, streamOf(bytes), { mime, size: BigInt(bytes.length) });
    } finally {
        await driver.dispose().catch(() => undefined);
    }

    await prisma.userAvatar.upsert({
        where: { userId },
        create: { userId, connectionId: target.id === LOCAL_TARGET ? null : target.id, path, mime, size: bytes.length },
        update: { connectionId: target.id === LOCAL_TARGET ? null : target.id, path, mime, size: bytes.length }
    });

    if (previous) await removeFile(previous.connectionId, previous.path);
}

/** Go back to initials, or to Gravatar if this instance uses it. */
export async function deleteAvatar(userId: string): Promise<void> {
    const existing = await prisma.userAvatar.findUnique({ where: { userId } });
    if (!existing) return;
    await prisma.userAvatar.delete({ where: { userId } });
    await removeFile(existing.connectionId, existing.path);
}

/**
 * Take the file with the row where that is possible.
 *
 * A file the storage refuses to delete (a NAS that is away, a connection that
 * has been removed) does not hold up the change: the person asked for their
 * photo to stop being their photo, and leaving an orphan on a disk its owner can
 * reach is a smaller problem than refusing them.
 */
async function removeFile(connectionId: string | null, path: string): Promise<void> {
    try {
        const driver = await driverForTarget(connectionId ?? LOCAL_TARGET, LOCAL_FOLDER);
        try {
            await driver.delete(path);
        } finally {
            await driver.dispose().catch(() => undefined);
        }
    } catch (error) {
        console.error(`avatars: could not remove ${path}:`, error);
    }
}

interface AvatarImage {
    readonly bytes: Uint8Array;
    readonly mime: string;
    /** Changes whenever the picture does, so a browser can be told to keep the
     *  one it has rather than fetch it again. */
    readonly etag: string;
}

/**
 * A picture, identified before it is fetched.
 *
 * The tag is separate from the bytes on purpose. Once a browser has a face it
 * spends the rest of the day asking "still this one?", and answering that by
 * reading the whole file back off a NAS - for every person on a board, every
 * five minutes - is most of the work for none of the result. Knowing the tag
 * costs one row.
 */
export interface AvatarRef {
    readonly etag: string;
    readonly mime: string;
    /** Null when the storage that holds it cannot be reached. */
    readonly load: () => Promise<Uint8Array | null>;
}

/** The photo somebody uploaded, or null when they have not. */
async function uploadedAvatar(userId: string): Promise<AvatarRef | null> {
    const row = await prisma.userAvatar.findUnique({ where: { userId } });
    if (!row) return null;
    return {
        etag: `"u${row.updatedAt.getTime()}"`,
        mime: row.mime,
        load: async () => {
            const driver = await driverForTarget(row.connectionId ?? LOCAL_TARGET, LOCAL_FOLDER);
            try {
                return await drain(await driver.readStream(row.path));
            } catch (error) {
                // A NAS that is away shows initials rather than a broken image.
                // Not silently: an operator needs to know a disk went missing.
                console.error(`avatars: could not read ${row.path}:`, error);
                return null;
            } finally {
                await driver.dispose().catch(() => undefined);
            }
        }
    };
}

// ---------------------------------------------------------------------------
// Gravatar
// ---------------------------------------------------------------------------

/** Gravatar keys an address by the SHA-256 of it, trimmed and lowercased. */
export function gravatarHash(email: string): string {
    return createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
}

/** Big enough for the largest place Polaris draws a face, and still small. */
const GRAVATAR_SIZE = 200;

/**
 * How long a Gravatar answer is trusted.
 *
 * People change their Gravatar about never, and a board full of faces would
 * otherwise be a board full of outbound requests. A day is short enough that a
 * change shows up the same week and long enough that the traffic is negligible.
 */
const GRAVATAR_TTL_MS = 24 * 60 * 60 * 1000;

/** Never let a slow or blocked network hold an avatar request open. */
const GRAVATAR_TIMEOUT_MS = 4000;

/** Remembered per address, misses included - "this address has no Gravatar" is
 *  the answer worth caching hardest, since it is the common one. */
const gravatarCache = new Map<string, { at: number; image: AvatarImage | null }>();

/**
 * What Gravatar has for an address, or null.
 *
 * `d=404` is what makes the third answer possible: asked this way Gravatar says
 * "nobody" instead of handing back a generated pattern, so an account with no
 * picture anywhere can still fall through to its initials.
 */
async function gravatarImage(email: string): Promise<AvatarImage | null> {
    const hash = gravatarHash(email);
    const cached = gravatarCache.get(hash);
    if (cached && Date.now() - cached.at < GRAVATAR_TTL_MS) return cached.image;

    let image: AvatarImage | null = null;
    try {
        const response = await fetch(`https://gravatar.com/avatar/${hash}?d=404&s=${GRAVATAR_SIZE}`, {
            signal: AbortSignal.timeout(GRAVATAR_TIMEOUT_MS)
        });
        if (response.ok) {
            const bytes = new Uint8Array(await response.arrayBuffer());
            // Gravatar is a third party like any other: what it serves is
            // checked against the same list an upload is, not trusted by name.
            const mime = sniffImageMime(bytes);
            // Tagged by the picture rather than the address: the address never
            // changes, so tagging by it would pin the first Gravatar somebody
            // had into every browser that ever loaded it.
            if (mime && bytes.length <= MAX_AVATAR_BYTES) {
                image = { bytes, mime, etag: `"g${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}"` };
            }
        }
    } catch (error) {
        // Offline, blocked, or slow. Not worth a line per avatar on every page,
        // and the cache below keeps it from being retried on the next one.
        if (!gravatarCache.has(hash)) console.error("avatars: gravatar unreachable:", error);
    }

    gravatarCache.set(hash, { at: Date.now(), image });
    return image;
}

/** Forget an address, so a photo taken down here is not shadowed by a stale
 *  "this account has a Gravatar" for the rest of the day. */
export function forgetGravatar(email: string): void {
    gravatarCache.delete(gravatarHash(email));
}

// ---------------------------------------------------------------------------
// What the route serves
// ---------------------------------------------------------------------------

/**
 * The picture for an account, or null when it has none and should be drawn as
 * initials. Uploaded first, then Gravatar, and nothing after that.
 *
 * A Gravatar arrives already fetched, because whether one exists is only
 * answerable by asking - but the answer is remembered for a day, so this is a
 * lookup rather than a request nearly every time.
 */
export async function resolveAvatar(userId: string): Promise<AvatarRef | null> {
    const uploaded = await uploadedAvatar(userId);
    if (uploaded) return uploaded;
    if (!(await gravatarEnabled())) return null;
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
    if (!user) return null;
    const image = await gravatarImage(user.email);
    return image ? { etag: image.etag, mime: image.mime, load: async () => image.bytes } : null;
}

/** The drivers speak in streams, because most of what they carry is far too big
 *  to hold; a profile photo is capped at 2 MB and is simpler as bytes. */
function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(bytes);
            controller.close();
        }
    });
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = stream.getReader();
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        total += value.length;
        // A stored photo cannot be bigger than this, so anything that is has
        // been replaced under us on the storage; stop rather than read it in.
        if (total > MAX_AVATAR_BYTES) {
            await reader.cancel().catch(() => undefined);
            throw new Error("That file is too big to be a profile photo");
        }
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
    }
    return bytes;
}
