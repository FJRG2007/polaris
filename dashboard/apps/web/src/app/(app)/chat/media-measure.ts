"use client";

/**
 * Measuring a picture or video on its way out: its pixel size and a ThumbHash
 * of it, for every reader to draw the bubble at its final size, blurred, before
 * the bytes arrive - see `lib/chat/media-shape`.
 *
 * Done in the sender's browser because the bytes are already here; the server
 * checks what this answers and never decodes the file to work it out itself.
 * Anything that goes wrong answers null, and the message goes without it.
 */

import { encodeThumbHash, type MediaShape } from "@/lib/chat/media-shape";

/** A ThumbHash is made from at most 100 pixels a side. */
const HASH_SIDE = 100;
const PATIENCE_MS = 5_000;

function isPicture(file: File): boolean {
    // An SVG has no pixel size of its own to keep.
    return file.type.startsWith("image/") && file.type !== "image/svg+xml";
}

function isVideo(file: File): boolean {
    return file.type.startsWith("video/");
}

function hashOf(source: ImageBitmap): string | null {
    const scale = HASH_SIDE / Math.max(source.width, source.height);
    const width = Math.max(1, Math.round(source.width * Math.min(1, scale)));
    const height = Math.max(1, Math.round(source.height * Math.min(1, scale)));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return null;
    context.drawImage(source, 0, 0, width, height);
    return encodeThumbHash(width, height, context.getImageData(0, 0, width, height).data);
}

/** How big a video's frames are, from its header alone. */
function videoSize(file: File): Promise<{ width: number; height: number } | null> {
    const address = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.muted = true;
    video.preload = "metadata";
    return new Promise<{ width: number; height: number } | null>((resolve) => {
        const done = (size: { width: number; height: number } | null) => {
            clearTimeout(timer);
            video.removeAttribute("src");
            video.load();
            URL.revokeObjectURL(address);
            resolve(size);
        };
        const timer = setTimeout(() => done(null), PATIENCE_MS);
        video.onerror = () => done(null);
        video.onloadedmetadata = () =>
            done(video.videoWidth && video.videoHeight ? { width: video.videoWidth, height: video.videoHeight } : null);
        video.src = address;
    });
}

/**
 * The shape of one file, or null for anything that is not a picture or a video
 * or that this browser cannot read. `still` is the frame already taken from a
 * video for its poster, so the video is not decoded a second time for the blur.
 */
export async function measureMedia(file: File, still?: Blob | null): Promise<MediaShape | null> {
    if (typeof document === "undefined") return null;
    try {
        if (isPicture(file)) {
            // `from-image` turns a phone photo the way its EXIF says, which is
            // the way every browser draws it.
            const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
            try {
                return { width: bitmap.width, height: bitmap.height, thumbhash: hashOf(bitmap) };
            } finally {
                bitmap.close();
            }
        }
        if (isVideo(file)) {
            const size = await videoSize(file);
            if (!still) return size ? { ...size, thumbhash: null } : null;
            const bitmap = await createImageBitmap(still);
            try {
                const fallback = { width: bitmap.width, height: bitmap.height };
                return { ...(size ?? fallback), thumbhash: hashOf(bitmap) };
            } finally {
                bitmap.close();
            }
        }
    } catch {
        return null;
    }
    return null;
}
