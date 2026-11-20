/**
 * The size of a picture or video and a blurred stand-in for it, known before a
 * byte of the file itself has arrived.
 *
 * Measured once, by the browser that sends it - the bytes are already there -
 * and kept on the attachment. A reader then draws the bubble at its final size
 * with the blur inside it and fades the real picture in over it, which is what
 * WhatsApp, Telegram and Discord do: no list that jumps as pictures land, and no
 * grey rectangles while they come.
 *
 * The stand-in is a ThumbHash (https://evanw.github.io/thumbhash/): unlike a
 * BlurHash it keeps the aspect ratio and transparency, and it is about 25 bytes.
 * This module is shared by both ends: the browser encodes and draws, the server
 * checks what a browser sent before it is kept, because it is client data that
 * every other reader's browser is going to decode.
 */

import { z } from "zod";
import * as thumbhash from "@/lib/media/thumbhash";

/** Bigger than any camera makes, small enough that a typo is refused. */
export const MEDIA_SIDE_CEILING = 30_000;

/** A ThumbHash is 5 bytes at least and about 25 at most; anything past this is
 *  not one. 48 bytes is 64 characters of base64. */
const HASH_BYTES_FLOOR = 5;
const HASH_BYTES_CEILING = 48;

export interface MediaShape {
    readonly width: number;
    readonly height: number;
    /** Base64, or null when the size is known and the picture could not be read. */
    readonly thumbhash: string | null;
}

function fromBase64(text: string): Uint8Array | null {
    try {
        const raw = atob(text);
        const bytes = new Uint8Array(raw.length);
        for (let at = 0; at < raw.length; at++) bytes[at] = raw.charCodeAt(at);
        return bytes;
    } catch {
        return null;
    }
}

function toBase64(bytes: Uint8Array): string {
    let raw = "";
    for (const byte of bytes) raw += String.fromCharCode(byte);
    return btoa(raw);
}

/** Whether a string is a ThumbHash this code can draw: the right size, and one
 *  that decodes to a small image rather than throwing or answering garbage. */
export function isThumbHash(text: string): boolean {
    const bytes = fromBase64(text);
    if (!bytes || bytes.length < HASH_BYTES_FLOOR || bytes.length > HASH_BYTES_CEILING) return false;
    try {
        const image = thumbhash.thumbHashToRGBA(bytes);
        return (
            Number.isInteger(image.w) &&
            Number.isInteger(image.h) &&
            image.w >= 1 &&
            image.h >= 1 &&
            image.w <= 32 &&
            image.h <= 32 &&
            image.rgba.length === image.w * image.h * 4
        );
    } catch {
        return false;
    }
}

const side = z.number().int().min(1).max(MEDIA_SIDE_CEILING);

/** One file's shape as a browser sends it, keyed short because it rides every
 *  message with pictures in it. */
export const mediaShapeSchema = z
    .object({
        w: side,
        h: side,
        th: z
            .string()
            .max(64)
            .regex(/^[A-Za-z0-9+/]+={0,2}$/)
            .refine(isThumbHash)
            .nullable()
            .optional()
    })
    .strict();

/** The `media` field of a message: one entry per file, in file order, null for
 *  a file with nothing to say (a document, a sound). */
export const mediaShapesSchema = z.array(mediaShapeSchema.nullable()).max(25);

/** Read the field. A shape that does not check out is dropped, never refused:
 *  the message is still the message, only drawn the way an older one is. */
export function readMediaShapes(raw: unknown): (MediaShape | null)[] {
    if (typeof raw !== "string" || raw.length === 0 || raw.length > 8192) return [];
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return [];
    }
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(0, 25).map((entry) => {
        const one = mediaShapeSchema.safeParse(entry);
        return one.success
            ? { width: one.data.w, height: one.data.h, thumbhash: one.data.th ?? null }
            : null;
    });
}

/**
 * Put the shapes a message named on its files, by position over the first
 * `named` of them. Never believed for anything that is not a picture or a
 * video, whatever the browser said.
 */
export function withMediaShapes<T extends { readonly contentType: string }>(
    files: readonly T[],
    shapes: readonly (MediaShape | null)[],
    named: number
): T[] {
    return files.map((file, position) => {
        const shape = shapes[position];
        if (!shape || position >= named || !/^(image|video)\//.test(file.contentType)) return file;
        return { ...file, width: shape.width, height: shape.height, thumbhash: shape.thumbhash };
    });
}

/** The shape in the form the message field carries it. */
export function writeMediaShape(shape: MediaShape | null): z.input<typeof mediaShapeSchema> | null {
    if (!shape) return null;
    return { w: shape.width, h: shape.height, ...(shape.thumbhash ? { th: shape.thumbhash } : {}) };
}

/** Encode pixels already scaled to fit 100x100. */
export function encodeThumbHash(width: number, height: number, rgba: ArrayLike<number>): string {
    return toBase64(thumbhash.rgbaToThumbHash(width, height, rgba));
}

const drawn = new Map<string, string>();

/** The blur as an image address, decoded once per hash per tab. */
export function placeholderUrl(hash: string | null | undefined): string | undefined {
    if (!hash) return undefined;
    const known = drawn.get(hash);
    if (known) return known;
    const bytes = fromBase64(hash);
    if (!bytes) return undefined;
    try {
        const url = thumbhash.thumbHashToDataURL(bytes);
        // Bounded: a long scroll through a busy room must not keep every blur.
        if (drawn.size >= 500) drawn.delete(drawn.keys().next().value as string);
        drawn.set(hash, url);
        return url;
    } catch {
        return undefined;
    }
}

/**
 * The size to draw a picture at inside a bubble: its own, scaled down to fit
 * the box and never up. Null when nothing was measured.
 */
export function fittedSize(
    width: number | null | undefined,
    height: number | null | undefined,
    box: { readonly width: number; readonly height: number }
): { width: number; height: number } | null {
    if (!width || !height || width <= 0 || height <= 0) return null;
    const scale = Math.min(1, box.width / width, box.height / height);
    return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}
