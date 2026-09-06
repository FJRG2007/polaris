/**
 * Whether a file can have a picture at all, decided by its name.
 *
 * Its own module because both sides need the answer and only one of them may
 * have the rest. The grid asks it in the browser, to know whether to render an
 * image element at all - a tile that can never have a picture should not spend a
 * request finding that out - and the route asks it on the server before it opens
 * anything. The server half imports an image library and a canvas, so a client
 * component reaching into it would pull both into the bundle.
 *
 * By extension rather than by sniffing the bytes, because this decides whether
 * to OPEN the file - and a test that has to read the file to know whether to
 * read the file is not a test. A name that lies costs one failed render and an
 * icon, which is what a name that lies deserves.
 */

const IMAGE_TYPES = new Set([
    ".jpg",
    ".jpeg",
    ".png",
    ".webp",
    ".gif",
    ".avif",
    ".tif",
    ".tiff",
    ".bmp",
    ".heic",
    ".heif",
    ".svg"
]);

export type ThumbnailKind = "image" | "pdf";

/**
 * The videos a browser will draw a frame of for itself.
 *
 * Deliberately not part of `thumbnailKind`: nothing on the server opens these.
 * The browser already holds a decoder, the download route honours Range, and a
 * four-gigabyte film therefore costs the first chunk of itself and nothing else
 * - where drawing it here would mean a decoder in the image and the whole file
 * read into memory to produce four kilobytes.
 *
 * The list is what every browser plays rather than everything that exists: a
 * name that is not here keeps its icon, which is what it did before.
 */
const MOVING_TYPES = new Set([".mp4", ".m4v", ".webm", ".ogv", ".mov"]);

/** Whether the tile should hand this to a video element rather than ask the
 *  server for a picture. */
export function drawsItsOwnFrame(name: string): boolean {
    const dot = name.lastIndexOf(".");
    return dot >= 0 && MOVING_TYPES.has(name.slice(dot).toLowerCase());
}

/**
 * The ceilings, past which a file simply keeps its icon.
 *
 * Not arbitrary: the original has to be held in memory to be drawn, and a
 * request that reads a gigabyte to produce four kilobytes is a request that
 * should not have been made. A camera's raw frame and a scanned book are both
 * comfortably inside these. A disk image is not, and does not want a preview.
 */
const IMAGE_CEILING = 40 * 1024 * 1024;
const PDF_CEILING = 60 * 1024 * 1024;

/** What kind of picture this name can produce, or null for a file that keeps
 *  its icon. */
export function thumbnailKind(name: string): ThumbnailKind | null {
    const dot = name.lastIndexOf(".");
    const extension = dot < 0 ? "" : name.slice(dot).toLowerCase();
    if (extension === ".pdf") return "pdf";
    return IMAGE_TYPES.has(extension) ? "image" : null;
}

/** Whether a file of this kind and size is worth opening. */
export function withinCeiling(kind: ThumbnailKind, size: bigint): boolean {
    return size > 0n && size <= BigInt(kind === "pdf" ? PDF_CEILING : IMAGE_CEILING);
}
