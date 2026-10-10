"use client";

/**
 * A picture somebody chose, dropped or pasted, made fit to keep in a deck.
 *
 * A deck travels whole to everybody who opens it, so a picture is drawn again
 * at no more than a full-HD slide's longest side and written as WebP - the way
 * Excalidraw shrinks what is dropped on a drawing before keeping it (1440 px
 * there; a slide is shown full screen, so a little more here). A picture that
 * is still too large after that is refused with a reason, never half-kept.
 */

/** The longest side a kept picture has, in pixels. */
const LONGEST_SIDE_PX = 1920;

/** The largest a picture may be when it is chosen. */
const LARGEST_FILE_BYTES = 25 * 1024 * 1024;

/** The largest a kept picture may be, as the text it is stored as. */
const LARGEST_KEPT_CHARS = 2_500_000;

export type PictureRefusal = "notAPicture" | "tooLarge" | "unreadable";

export type ReadPicture =
    | { ok: true; data: string; width: number; height: number }
    | { ok: false; reason: PictureRefusal };

/** Whether a file is something the browser can draw as a picture. */
export function isPicture(file: File): boolean {
    return file.type.startsWith("image/");
}

function loadImage(url: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error("unreadable"));
        image.src = url;
    });
}

export async function readPicture(file: File): Promise<ReadPicture> {
    if (!isPicture(file)) return { ok: false, reason: "notAPicture" };
    if (file.size > LARGEST_FILE_BYTES) return { ok: false, reason: "tooLarge" };
    const url = URL.createObjectURL(file);
    try {
        const image = await loadImage(url);
        const width = image.naturalWidth || 0;
        const height = image.naturalHeight || 0;
        if (width === 0 || height === 0) return { ok: false, reason: "unreadable" };
        const scale = Math.min(1, LONGEST_SIDE_PX / Math.max(width, height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(width * scale));
        canvas.height = Math.max(1, Math.round(height * scale));
        const context = canvas.getContext("2d");
        if (!context) return { ok: false, reason: "unreadable" };
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        // A browser that cannot write WebP hands back PNG, which still works.
        for (const quality of [0.9, 0.75, 0.6]) {
            const data = canvas.toDataURL("image/webp", quality);
            if (data.length <= LARGEST_KEPT_CHARS && data.startsWith("data:image/"))
                return { ok: true, data, width, height };
        }
        return { ok: false, reason: "tooLarge" };
    } catch {
        return { ok: false, reason: "unreadable" };
    } finally {
        URL.revokeObjectURL(url);
    }
}
