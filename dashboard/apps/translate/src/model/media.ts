/**
 * What a file really is, read from its first bytes: a name or a declared type
 * says nothing anybody can trust. Shared by the screen (to refuse early) and
 * the server (to refuse for real).
 */

/** One line of text in a picture; `box` is `[x, y, width, height]`, 0 to 1. */
export interface ImageLine {
    text: string;
    box: [number, number, number, number] | null;
}

/** The largest picture read, in bytes. */
export const IMAGE_MAX_BYTES = 8 * 1024 * 1024;
/** The largest recording transcribed at once, in bytes: what Polar's dictation takes. */
export const AUDIO_MAX_BYTES = 8 * 1024 * 1024;
/** The longest recording transcribed at once, in seconds. */
export const AUDIO_MAX_SECONDS = 300;
/** The largest document translated, in bytes. */
export const DOCUMENT_MAX_BYTES = 25 * 1024 * 1024;

function starts(bytes: Uint8Array, signature: readonly number[], at = 0): boolean {
    if (bytes.length < at + signature.length) return false;
    return signature.every((byte, index) => bytes[at + index] === byte);
}

const ascii = (text: string): number[] => [...text].map((char) => char.charCodeAt(0));

export type ImageType = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

export function sniffImage(bytes: Uint8Array): ImageType | null {
    if (starts(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
    if (starts(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
    if (starts(bytes, ascii("RIFF")) && starts(bytes, ascii("WEBP"), 8)) return "image/webp";
    if (starts(bytes, ascii("GIF87a")) || starts(bytes, ascii("GIF89a"))) return "image/gif";
    return null;
}

export type AudioType = "audio/webm" | "audio/ogg" | "audio/wav" | "audio/mpeg" | "audio/mp4";

export function sniffAudio(bytes: Uint8Array): AudioType | null {
    if (starts(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return "audio/webm";
    if (starts(bytes, ascii("OggS"))) return "audio/ogg";
    if (starts(bytes, ascii("RIFF")) && starts(bytes, ascii("WAVE"), 8)) return "audio/wav";
    if (starts(bytes, ascii("ID3"))) return "audio/mpeg";
    // An MPEG audio frame: eleven sync bits.
    if (bytes.length > 1 && bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0) {
        return "audio/mpeg";
    }
    if (starts(bytes, ascii("ftyp"), 4)) return "audio/mp4";
    return null;
}

export type DocumentKind = "zip" | "pdf" | "text";

/** A zip (the Office formats), a PDF, or plain UTF-8 text; anything else is null. */
export function sniffDocument(bytes: Uint8Array): DocumentKind | null {
    if (starts(bytes, [0x50, 0x4b, 0x03, 0x04])) return "zip";
    if (starts(bytes, ascii("%PDF-"))) return "pdf";
    const head = bytes.subarray(0, 4096);
    if (head.includes(0)) return null;
    try {
        new TextDecoder("utf-8", { fatal: true }).decode(head.subarray(0, lastWhole(head)));
        return "text";
    } catch {
        return null;
    }
}

/** Where the last whole UTF-8 character in `bytes` ends, so a cut one is not an error. */
function lastWhole(bytes: Uint8Array): number {
    let end = bytes.length;
    for (let back = 1; back <= 3 && end - back >= 0; back++) {
        const byte = bytes[end - back]!;
        if ((byte & 0xc0) === 0x80) continue;
        if (byte >= 0xc0) end -= back;
        break;
    }
    return end;
}
