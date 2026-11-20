/**
 * The small picture of a file, for the grid.
 *
 * A grid of file icons tells somebody nothing the name did not already tell
 * them. A grid of pictures is how a person finds the photograph, the scan or the
 * contract without opening six of them first, which is what every file manager
 * has done for twenty years and what this view was missing.
 *
 * The whole design follows from one rule: **an original is read at most once,
 * ever.**
 *
 *   - Nothing is made while listing a folder. A hundred entries scroll past and
 *     not one file is opened; a tile asks for its picture only when it comes
 *     near the screen, so a folder somebody scrolls straight through costs
 *     nothing at all.
 *   - What is made is kept, under a name derived from the file's own identity -
 *     where it is, when it changed, how big it is - so the second visit is a few
 *     kilobytes off the cache and no original is touched. A file that is edited
 *     asks for a name that does not exist yet, so nothing has to be invalidated
 *     and no stale picture can be served.
 *   - Two tiles wanting the same picture in the same moment wait on one piece of
 *     work rather than starting two, which is what dragging a scrollbar does.
 *
 * The cache lives on the instance's own storage rather than inside the drive the
 * file came from. A folder that grows a hidden directory of thumbnails is a
 * folder that looks different on the NAS than it does here, and somebody would
 * eventually find it and wonder what it was.
 */

import { join } from "node:path";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { coalescer } from "@/lib/coalesce";
import { getSetting } from "@/lib/setting-store";
import type { StorageDriver } from "@polaris/storage";
import { PERSONAL_LOCAL_FOLDER } from "@/lib/storage-service";
// The one question both sides ask, kept where a client component may ask it.
import { type ThumbnailKind } from "@/lib/drive-thumbnail-kind";
import { driverForTarget, resolveTargetChoice, LOCAL_TARGET } from "@/lib/storage-target";

export { thumbnailKind, withinCeiling, type ThumbnailKind } from "@/lib/drive-thumbnail-kind";

/** The longest edge of a thumbnail. Twice the largest the grid draws, so a
 *  high-density screen has real pixels to work with, and still a few kilobytes
 *  rather than a few hundred. */
export const THUMBNAIL_EDGE = 256;

/** Where thumbnails made from now on are kept. Its own setting for the reason a
 *  personal drive has one: this is the instance's own scratch, and the disk that
 *  suits it is not necessarily the one holding people's files. */
export const THUMBNAIL_TARGET_KEY = "drive.thumbnails.target";

/**
 * The disk they land on when nobody has chosen one.
 *
 * This server, and deliberately not the automatic rule the rest of the uploads
 * follow. That rule prefers a NAS, and a NAS is a drive people BROWSE: one
 * cache holding small copies of everything anybody has looked at - including
 * files behind a password this same route refuses to open - would sit at the
 * root of a share, readable by everyone who can list it. What is written here
 * is derived from other people's files, so it stays on Polaris's own disk
 * unless an administrator says otherwise.
 */
const THUMBNAIL_TARGET_DEFAULT = LOCAL_TARGET;

/**
 * The name a picture is kept under.
 *
 * Everything that can change what the picture should look like is in it - which
 * connection, which path, when it changed, how big it is - so a file that is
 * edited does not invalidate anything: it asks for a name that does not exist
 * yet, and the old one is never requested again. That is also what lets the
 * browser hold the response for a year without it ever being wrong.
 */
export function thumbnailKey(
    connectionId: string,
    path: string,
    modifiedAt: Date,
    size: bigint
): string {
    return createHash("sha256")
        .update(`${connectionId}\0${path}\0${modifiedAt.getTime()}\0${size}`)
        .digest("hex");
}

/** Where that name lives on the instance's own storage. Sharded, because a
 *  directory holding a hundred thousand entries is slow to open on every
 *  filesystem that has ever existed. */
export function thumbnailPath(key: string): string {
    return `polaris/thumbnails/${key.slice(0, 2)}/${key}.webp`;
}

async function openCache(): Promise<StorageDriver> {
    const chosen = await getSetting(THUMBNAIL_TARGET_KEY);
    const target = await resolveTargetChoice(chosen ?? THUMBNAIL_TARGET_DEFAULT);
    // The same folder people's files are rooted at on the local disk, so an
    // operator looking at their storage sees one Polaris directory rather than
    // two. What is ours stays under a name of its own inside it.
    return driverForTarget(target.id, PERSONAL_LOCAL_FOLDER);
}

/** Everything a stream holds, as one buffer. */
export async function collectStream(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
    const chunks: Uint8Array[] = [];
    const reader = stream.getReader();
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) chunks.push(value);
    }
    return Buffer.concat(chunks);
}

/**
 * What was kept for this file earlier, or null when nothing was.
 *
 * Wrapped rather than handed back bare because "nothing is there" and "what is
 * there is empty" are different answers: an empty entry is a file that was
 * tried once and could not be drawn, and the whole point of recording that is
 * that the original is never opened for it again. A cache that cannot be read
 * is a miss and never the reason a grid fails to draw.
 */
async function fromCache(key: string): Promise<{ bytes: Buffer } | null> {
    let driver: StorageDriver | null = null;
    try {
        driver = await openCache();
        const at = thumbnailPath(key);
        const stat = await driver.stat(at);
        if (stat.kind !== "file") return null;
        return { bytes: await collectStream(await driver.readStream(at)) };
    } catch {
        return null;
    } finally {
        await driver?.dispose().catch(() => undefined);
    }
}

/** Keep what was worked out for next time - a picture, or nothing at all for a
 *  file that could not be drawn. Failing is not worth telling anybody about: the
 *  tile already has what it asked for, and the only cost is working it out
 *  again. */
async function intoCache(key: string, bytes: Buffer): Promise<void> {
    let driver: StorageDriver | null = null;
    try {
        driver = await openCache();
        const at = thumbnailPath(key);
        await driver.mkdir(at.slice(0, at.lastIndexOf("/"))).catch(() => undefined);
        await driver.writeStream(
            at,
            new ReadableStream<Uint8Array>({
                start(controller) {
                    // Nothing at all rather than a chunk of nothing. A body with
                    // no bytes in it is one that closes without a chunk, and
                    // that is what is written for every file that could not be
                    // drawn - a zero-length chunk is a different thing to the
                    // streams this ends up in.
                    if (bytes.byteLength > 0) controller.enqueue(new Uint8Array(bytes));
                    controller.close();
                }
            }),
            { size: BigInt(bytes.byteLength) }
        );
    } catch {
        return;
    } finally {
        await driver?.dispose().catch(() => undefined);
    }
}

/** As much of a file as has to be read to know whether it is markup at all. A
 *  document announces itself in its first bytes or it is not one. */
const MARKUP_HEAD = 4096;

/** The most an SVG may be. A drawing is markup - a few kilobytes, tens at the
 *  outside - and nothing legitimate here is a megabyte of it. */
const MARKUP_CEILING = 1024 * 1024;

/**
 * Whether this is markup nobody should hand to a rasteriser.
 *
 * An SVG is the one thing in the drawable set that is a DOCUMENT rather than
 * pixels, and an XML document may declare entities in terms of each other. Five
 * levels of that is four hundred bytes somebody can upload and scroll past, and
 * it is not a theoretical cost: measured against this build, one such file held
 * a core and a gigabyte of memory and had not finished five minutes later.
 * Nothing downstream can end it either - the work happens inside a native
 * library, on a thread that never comes back - so the only place to stop it is
 * before it starts. The same declaration is what an SVG would name a local file
 * through, so refusing it closes both.
 *
 * Decided by what the bytes say rather than by the name, because the name is the
 * part anybody can choose, and across the whole file rather than its head: a
 * declaration may legally follow any amount of comment, and padding it out is
 * the first thing somebody would try.
 */
function isHostileMarkup(bytes: Buffer): boolean {
    if (!/^\s*<[?!a-z]/i.test(asText(bytes.subarray(0, MARKUP_HEAD)))) return false;
    if (bytes.byteLength > MARKUP_CEILING) return true;
    return /<!ENTITY/i.test(asText(bytes));
}

/** Bytes as something to look for a declaration in. The zero bytes go so a file
 *  written in UTF-16 reads as its own text - half of every character there is
 *  one - and the byte-order mark in front of it goes with them. */
function asText(bytes: Buffer): string {
    // Written as escapes so this file stays plain ASCII: NUL, and the two bytes
    // a UTF-16 mark is made of.
    return bytes.toString("latin1").replace(/[\0\u00FE\u00FF]/g, "");
}

/**
 * An image, made small.
 *
 * `rotate()` with no argument applies the orientation the camera recorded, which
 * is the difference between a portrait photograph and a portrait photograph
 * lying on its side in the grid.
 */
async function drawImage(bytes: Buffer): Promise<Buffer> {
    if (isHostileMarkup(bytes)) throw new Error("This drawing declares more than it draws");
    const { default: sharp } = await import("sharp");
    return await sharp(bytes, { animated: false })
        .rotate()
        .resize(THUMBNAIL_EDGE, THUMBNAIL_EDGE, { fit: "inside", withoutEnlargement: true })
        .webp({ quality: 72 })
        .toBuffer();
}

/**
 * Where the library finds its own fallback fonts and character maps.
 *
 * The same directory the viewer is served from, read off the disk rather than
 * over HTTP because this runs on the server. Absent rather than wrong when the
 * directory is not there: the library warns and draws what it can, which is
 * still better than refusing to draw anything.
 */
function pdfAssets(): { standardFontDataUrl?: string; cMapUrl?: string; cMapPacked?: boolean } {
    const staged = join(process.cwd(), "public", "pdfjs");
    if (!existsSync(staged)) return {};
    // A plain path with a forward slash on the end, and both halves are load
    // bearing. The library refuses anything without the trailing slash outright,
    // and reads a path from disk while a file:// URL goes to `fetch`, which does
    // not serve files - so the URL form is accepted and then silently fails to
    // load a single font. The difference is visible in the picture: without them
    // a page of text renders in a washed-out substitute rather than in ink.
    const at = (name: string) => `${join(staged, name).replaceAll("\\", "/")}/`;
    return { standardFontDataUrl: at("standard_fonts"), cMapUrl: at("cmaps"), cMapPacked: true };
}

/**
 * The first page of a document, made small.
 *
 * Through the library the viewer already uses and the canvas that library
 * already brings with it, so this adds nothing to the image that was not in it.
 * The page is drawn onto white: a PDF page has no background of its own, and one
 * rendered onto transparency is black text on whatever the grid happens to be
 * painted in.
 */
async function drawDocument(bytes: Buffer): Promise<Buffer> {
    const [pdf, canvasKit, { default: sharp }] = await Promise.all([
        import("pdfjs-dist/legacy/build/pdf.mjs"),
        import("@napi-rs/canvas"),
        import("sharp")
    ]);
    const opening = pdf.getDocument({
        data: new Uint8Array(bytes),
        // Nothing here is drawn for somebody to interact with, and a font the
        // document brought with it is not worth a network fetch to render one
        // page at 256 pixels.
        disableFontFace: true,
        // The fonts and character maps the library falls back to, which are the
        // same files already staged for the viewer. Without them a document that
        // is mostly TEXT - which a contract is - renders as an empty page, and an
        // empty page is a worse thumbnail than the icon it replaced.
        ...pdfAssets()
    });
    try {
        const document = await opening.promise;
        const page = await document.getPage(1);
        const unscaled = page.getViewport({ scale: 1 });
        const scale = THUMBNAIL_EDGE / Math.max(unscaled.width, unscaled.height);
        const viewport = page.getViewport({ scale });
        const canvas = canvasKit.createCanvas(
            Math.max(1, Math.ceil(viewport.width)),
            Math.max(1, Math.ceil(viewport.height))
        );
        const context = canvas.getContext("2d");
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({
            canvasContext: context as unknown as CanvasRenderingContext2D,
            viewport
        } as never).promise;
        return await sharp(canvas.toBuffer("image/png")).webp({ quality: 72 }).toBuffer();
    } finally {
        // What ends the document, its transport and the worker behind it -
        // `cleanup()` only lets go of what the page held. Held on the loading
        // task rather than the document so it covers the one that never opened
        // too: an encrypted contract is the commonest thing this cannot draw,
        // and a worker left behind for each one is a worker for the life of the
        // server.
        await opening.destroy().catch(() => undefined);
    }
}

/**
 * The work in flight, so one picture is never made twice at once.
 *
 * Dragging a scrollbar puts twenty tiles on the screen in a frame, and two of
 * them are routinely the same file seen from two places - a folder and a search
 * result. Without this, each one opens the original.
 */
const inFlight = coalescer<Buffer | null>();

/**
 * How many originals may be open at once, across everybody.
 *
 * A screenful of tiles asks in the same moment, and each answer holds a whole
 * original in memory while it is drawn - up to the ceilings, forty megabytes
 * for an image and sixty for a document. Unbounded, one cold folder of scans is
 * hundreds of megabytes and as many renders in flight, and all of those reads
 * go down the one pooled session the same person's listing and downloads are
 * using: the drive stops answering the things they are actually looking at. A
 * few at a time fills a folder in visibly and leaves the drive responsive.
 */
const DRAWING_AT_ONCE = 3;

let drawing = 0;
const queued: (() => void)[] = [];

/**
 * The expensive half - read the original, draw it - with at most
 * `DRAWING_AT_ONCE` of them happening anywhere in the process.
 *
 * A finished draw hands its place straight to whoever is waiting rather than
 * releasing it and letting the next arrival take it, so the count is a ceiling
 * rather than an average.
 */
async function whileDrawing<T>(work: () => Promise<T>): Promise<T> {
    if (drawing >= DRAWING_AT_ONCE) await new Promise<void>((go) => queued.push(go));
    else drawing += 1;
    try {
        return await work();
    } finally {
        const next = queued.shift();
        if (next) next();
        else drawing -= 1;
    }
}

/** What is kept for a file that cannot be drawn: an entry with nothing in it. */
const NOTHING = Buffer.alloc(0);

/**
 * The picture for a file: from the cache, or made once and kept.
 *
 * `read` is a function rather than the bytes because the entire point is not to
 * open the original unless there is no picture already. The caller hands over
 * the means, not the file.
 *
 * Null is the settled answer "this one keeps its icon", and it is kept as such.
 * A drive that would not give the original up is not an answer about the file at
 * all, so it is thrown rather than returned: the caller answers the same 404
 * either way, but nothing is written down and the next visit tries again.
 */
export async function thumbnailFor(
    kind: ThumbnailKind,
    key: string,
    read: () => Promise<Buffer>
): Promise<Buffer | null> {
    return inFlight.run(key, async () => {
        const cached = await fromCache(key);
        // An entry with nothing in it is a file that was tried once and could
        // not be drawn. It keeps its icon, and the original stays shut.
        if (cached) return cached.bytes.byteLength > 0 ? cached.bytes : null;

        const drawn = await whileDrawing(async () => {
            const original = await read();
            try {
                return kind === "pdf" ? await drawDocument(original) : await drawImage(original);
            } catch (error) {
                // A file that cannot be drawn keeps its icon, and says so by
                // being absent rather than by failing: an encrypted document, an
                // image whose name lies about what it is, a format this build
                // cannot read. Said out loud once, because otherwise a missing
                // native binary and an encrypted contract look identical from
                // both ends - a tile that kept its icon.
                console.warn(`drive: a ${kind} could not be drawn for the grid:`, error);
                return null;
            }
        });

        // Both answers are worth keeping. Without the second one this is the
        // hole in the rule the whole design rests on: the files that cost the
        // most to try would be the ones read in full again on every visit,
        // forever. The name carries the file's identity, so a file that is
        // edited asks a fresh question anyway.
        await intoCache(key, drawn ?? NOTHING);
        return drawn;
    });
}
