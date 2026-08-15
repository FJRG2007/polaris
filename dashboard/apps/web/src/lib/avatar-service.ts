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
    openForWriting,
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
 * Who a photo belongs to.
 *
 * An organization has a face for the same reasons a person does - it appears in
 * a switcher, a list and a header - and gets it the same way, through the same
 * storage target and the same size and format rules. Only the row differs, so
 * that is the only thing this discriminates.
 */
export type AvatarOwner = { readonly kind: "user"; readonly id: string } | { readonly kind: "org"; readonly id: string };

interface AvatarRow {
    readonly connectionId: string | null;
    readonly path: string;
    readonly updatedAt: Date;
    readonly mime: string;
}

async function readRow(owner: AvatarOwner): Promise<AvatarRow | null> {
    return owner.kind === "user"
        ? prisma.userAvatar.findUnique({ where: { userId: owner.id } })
        : prisma.organizationAvatar.findUnique({ where: { orgId: owner.id } });
}

/**
 * Replace a photo.
 *
 * The old file is removed after the new row is written rather than before: a
 * failed upload that has already deleted the previous photo leaves whoever
 * uploaded it worse off than when they started.
 */
export async function storeAvatar(owner: AvatarOwner, bytes: Uint8Array, mime: string): Promise<void> {
    const extension = ALLOWED_MIME.get(mime);
    if (!extension) throw new Error("That kind of image is not accepted");

    const previous = await readRow(owner);
    // Wherever photos are sent, or this server when that storage is not
    // answering - a share somebody unplugged is not a reason a person cannot
    // change their picture. Where it lands is what gets recorded.
    const target = await openForWriting(await resolveStorageTarget(AVATAR_TARGET_KEY), LOCAL_FOLDER);
    const driver = target.driver;
    // A name of its own rather than the owner's id: a photo replaced while
    // another browser still has the old one cached must not be served the new
    // bytes under the old name, and a name cannot escape the folder this way
    // either. The kind is in the name so the two never collide on one disk.
    const path = `${AVATAR_ROOT}/${owner.kind}-${safeName(owner.id)}-${crypto.randomUUID()}${extension}`;

    try {
        await driver.mkdir(AVATAR_ROOT).catch(() => undefined);
        await driver.writeStream(path, streamOf(bytes), { mime, size: BigInt(bytes.length) });
    } finally {
        await driver.dispose().catch(() => undefined);
    }

    const stored = {
        connectionId: target.targetId === LOCAL_TARGET ? null : target.targetId,
        path,
        mime,
        size: bytes.length
    };
    if (owner.kind === "user") {
        await prisma.userAvatar.upsert({
            where: { userId: owner.id },
            create: { userId: owner.id, ...stored },
            update: stored
        });
    } else {
        await prisma.organizationAvatar.upsert({
            where: { orgId: owner.id },
            create: { orgId: owner.id, ...stored },
            update: stored
        });
    }

    if (previous) await removeFile(previous.connectionId, previous.path);
}

/** Go back to initials - or, for an account, to Gravatar if this instance uses
 *  it. An organization has no Gravatar to fall back to. */
export async function deleteAvatar(owner: AvatarOwner): Promise<void> {
    const existing = await readRow(owner);
    if (!existing) return;
    if (owner.kind === "user") await prisma.userAvatar.delete({ where: { userId: owner.id } });
    else await prisma.organizationAvatar.delete({ where: { orgId: owner.id } });
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
async function uploadedAvatar(owner: AvatarOwner): Promise<AvatarRef | null> {
    const row = await readRow(owner);
    if (!row) return null;
    return {
        etag: `"u${row.updatedAt.getTime()}"`,
        mime: row.mime,
        load: async () => {
            // Opening the storage is itself a thing that fails - a session
            // against a box that is off - and it used to fail out here, past
            // every catch. That is a face that goes from initials to a broken
            // image the moment a share goes away, everywhere at once.
            const driver = await driverForTarget(
                row.connectionId ?? LOCAL_TARGET,
                LOCAL_FOLDER
            ).catch((error: unknown) => {
                console.error(`avatars: could not open the storage for ${row.path}:`, error);
                return null;
            });
            if (!driver) return null;
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

/**
 * How long a lookup that never got an answer stands.
 *
 * "Gravatar has nobody at this address" is an answer and keeps for a day. "We
 * could not ask" is not one, and treating it as if it were is how a single slow
 * moment takes everybody's face away for the rest of the day - a four-second
 * timeout on a home connection is not evidence about anybody's account. A minute
 * is long enough that a board full of faces does not retry a dead network once
 * per person, and short enough that nobody notices the outage ended.
 */
const GRAVATAR_RETRY_MS = 60 * 1000;

/** Never let a slow or blocked network hold an avatar request open. */
const GRAVATAR_TIMEOUT_MS = 4000;

interface GravatarMemo {
    /** When this stops being believed. */
    readonly until: number;
    readonly image: AvatarImage | null;
    /** Whether this is a remembered answer or a remembered failure to get one. */
    readonly failed: boolean;
}

/** Remembered per address, misses included - "this address has no Gravatar" is
 *  the answer worth caching hardest, since it is the common one. */
const gravatarCache = new Map<string, GravatarMemo>();

/**
 * What Gravatar has for an address, or null.
 *
 * `d=404` is what makes the third answer possible: asked this way Gravatar says
 * "nobody" instead of handing back a generated pattern, so an account with no
 * picture anywhere can still fall through to its initials.
 */
async function gravatarImage(email: string): Promise<GravatarAnswer> {
    const hash = gravatarHash(email);
    const cached = gravatarCache.get(hash);
    if (cached && Date.now() < cached.until) {
        return { image: cached.image, certain: !cached.failed };
    }

    let image: AvatarImage | null = null;
    let answered = false;
    try {
        const response = await fetch(`https://gravatar.com/avatar/${hash}?d=404&s=${GRAVATAR_SIZE}`, {
            signal: AbortSignal.timeout(GRAVATAR_TIMEOUT_MS)
        });
        // A picture and a 404 are both Gravatar telling us about the address.
        // A 429 or a 502 is Gravatar telling us about Gravatar, so it is worth
        // asking again shortly rather than standing in for an answer all day.
        answered = response.ok || response.status === 404;
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
        // Offline, blocked, or slow. Said once rather than once per avatar on
        // every page, and again only after the address has worked in between -
        // an operator needs to know egress broke, not to have the log filled
        // with it for as long as it stays broken.
        if (!cached?.failed) console.error("avatars: gravatar unreachable:", error);
    }

    // A failed lookup does not take away a face Polaris already had. The old
    // answer is kept and served while the retry window runs, because "the
    // network hiccuped" is not news about anybody's account - and without this
    // one slow moment blanks a face, the browser caches the blank for five
    // minutes, and the picture appears to come and go.
    const kept = answered ? image : (cached?.image ?? null);
    gravatarCache.set(hash, {
        until: Date.now() + (answered ? GRAVATAR_TTL_MS : GRAVATAR_RETRY_MS),
        image: kept,
        failed: !answered
    });
    return { image: kept, certain: answered };
}

/** A Gravatar answer, and whether it is one. `certain` is false when the lookup
 *  failed: the caller may still have a picture to serve - the last one - but
 *  must not let a browser cache "there is none" on the strength of it. */
interface GravatarAnswer {
    readonly image: AvatarImage | null;
    readonly certain: boolean;
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
 * What to serve for an account: the photo they uploaded, else their Gravatar,
 * else nothing and let the initials stand.
 *
 * A Gravatar arrives already fetched, because whether one exists is only
 * answerable by asking - but the answer is remembered for a day, so this is a
 * lookup rather than a request nearly every time.
 */
export interface AvatarAnswer {
    readonly picture: AvatarRef | null;
    /**
     * Whether "no picture" is a fact rather than a shrug.
     *
     * False only when a lookup failed, and it exists because of what the caller
     * does next: a browser told "no picture, keep that for five minutes" on the
     * strength of one timed-out request will hide a face that was there all
     * along, and hide it long after the network came back.
     */
    readonly certain: boolean;
}

export async function resolveAvatar(userId: string): Promise<AvatarAnswer> {
    const uploaded = await uploadedAvatar({ kind: "user", id: userId });
    if (uploaded) return { picture: uploaded, certain: true };
    if (!(await gravatarEnabled())) return { picture: null, certain: true };
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
    if (!user) return { picture: null, certain: true };

    const { image, certain } = await gravatarImage(user.email);
    return {
        picture: image ? { etag: image.etag, mime: image.mime, load: async () => image.bytes } : null,
        certain
    };
}

/**
 * The picture for an organization, or null when it has none.
 *
 * One answer rather than three: an organization has no email address, so there
 * is no Gravatar to fall through to and nothing to look up on a third party. It
 * is the uploaded photo or its initials, which is also why this cannot leak an
 * organization's existence - a 404 here is the same 404 as for one with no photo.
 */
export async function resolveOrgAvatar(orgId: string): Promise<AvatarRef | null> {
    return uploadedAvatar({ kind: "org", id: orgId });
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
