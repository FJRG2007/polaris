/**
 * What the one Translate box was handed, and which way it goes.
 *
 * The screen has a single input, the way Google Translate and DeepL do: typed
 * text, a pasted picture, a dropped or chosen file, or the address of a page.
 * This decides the path for each - text stays text, a picture is read and
 * translated in place, a document is rebuilt translated, a recording is
 * transcribed, a video is read frame by frame, an address is fetched as a page.
 *
 * Pure, so the routing is asserted in a test rather than found in a browser.
 */

import { z } from "zod";

/** Where an input is translated. */
export type InputKind = "image" | "document" | "audio" | "video";

/** Every file the box takes, written as a file input's `accept`. */
export const IMAGE_ACCEPT = "image/png,image/jpeg,image/webp,image/gif";
export const DOCUMENT_ACCEPT = ".docx,.pptx,.xlsx,.pdf,.txt,.md,.csv,.srt,.vtt";
export const AUDIO_ACCEPT = "audio/*";
export const VIDEO_ACCEPT = "video/*";
export const INPUT_ACCEPT = [IMAGE_ACCEPT, DOCUMENT_ACCEPT, AUDIO_ACCEPT, VIDEO_ACCEPT].join(",");

const IMAGE_NAME = /\.(?:png|jpe?g|webp|gif)$/i;
const DOCUMENT_NAME = /\.(?:docx|pptx|xlsx|pdf|txt|md|csv|srt|vtt)$/i;
const AUDIO_NAME = /\.(?:mp3|wav|flac|m4a|aac|ogg|oga|opus)$/i;
const VIDEO_NAME = /\.(?:mp4|mov|mkv|webm|avi|m4v)$/i;

/**
 * The path one file takes, from its type and then its name, or null when the
 * box cannot translate it. Each mode still reads the bytes before it trusts
 * either: this only decides where the file goes.
 */
export function routeFile(file: {
    readonly name: string;
    readonly type: string;
}): InputKind | null {
    const type = file.type.toLowerCase();
    if (/^image\/(?:png|jpeg|webp|gif)$/.test(type)) return "image";
    if (type.startsWith("audio/")) return "audio";
    if (type.startsWith("video/")) return "video";
    if (IMAGE_NAME.test(file.name)) return "image";
    if (DOCUMENT_NAME.test(file.name)) return "document";
    if (AUDIO_NAME.test(file.name)) return "audio";
    if (VIDEO_NAME.test(file.name)) return "video";
    if (type === "application/pdf" || type === "text/plain" || type === "text/markdown") {
        return "document";
    }
    return null;
}

/** One clipboard or drop item, as much of `DataTransferItem` as is read. */
export interface PastedItem {
    readonly kind: string;
    readonly type: string;
    getAsFile(): File | null;
}

/**
 * What a paste carries for the box: a file it can translate (a copied picture,
 * a copied file), or null for text, which the text box takes as it always did.
 * A copied picture often arrives with its HTML beside it; the picture wins,
 * which is what the person copying it meant. Text copied from Word, Excel or
 * OneNote arrives with a picture of itself beside its plain text; the text
 * wins there, so pasted text stays text.
 */
export function pastedFile(items: ArrayLike<PastedItem> | null | undefined): File | null {
    const all = Array.from(items ?? []);
    const carriesText = all.some(
        (item) => item.kind === "string" && (item.type === "text/plain" || item.type === "text/rtf")
    );
    if (carriesText) return null;
    const files = all.filter((item) => item.kind === "file");
    const ordered = [
        ...files.filter((item) => item.type.startsWith("image/")),
        ...files.filter((item) => !item.type.startsWith("image/"))
    ];
    for (const item of ordered) {
        const file = item.getAsFile();
        if (file && routeFile(file)) return file;
    }
    return null;
}

/** The longest page address taken. */
export const WEBSITE_URL_MAX = 2048;

/**
 * A page address as the server is asked for it: trimmed, given `https://`
 * when typed without a scheme, http or https only, no credentials in it, and
 * written back in its one canonical form (lowercase host, no fragment).
 */
export function normalizeWebsite(raw: string): string {
    const trimmed = raw.trim();
    if (!trimmed) return "";
    const schemed = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
    try {
        const url = new URL(schemed);
        url.hash = "";
        return url.toString();
    } catch {
        return trimmed;
    }
}

export const websiteUrl = z
    .string()
    .max(WEBSITE_URL_MAX)
    .transform(normalizeWebsite)
    .refine((value) => {
        try {
            const url = new URL(value);
            return (
                (url.protocol === "http:" || url.protocol === "https:") &&
                !url.username &&
                !url.password &&
                url.hostname.includes(".")
            );
        } catch {
            return false;
        }
    }, "invalidUrl");

export const websiteRequest = z.object({ url: websiteUrl }).strict();

/**
 * The address typed into the text box, when the whole of what was typed is
 * one: `example.com/page` or `https://example.com`, never a sentence that
 * happens to contain a link. That is when the box offers to translate the page.
 */
export function websiteOf(text: string): string | null {
    const trimmed = text.trim();
    if (!trimmed || /\s/.test(trimmed) || trimmed.length > WEBSITE_URL_MAX) return null;
    if (
        !/^(?:https?:\/\/)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?::\d+)?(?:[/?#]\S*)?$/i.test(
            trimmed
        )
    ) {
        return null;
    }
    const parsed = websiteUrl.safeParse(trimmed);
    return parsed.success ? parsed.data : null;
}
