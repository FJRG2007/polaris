/**
 * Minimal filename-to-MIME lookup for the byte-serving routes. Drivers do not
 * always report a content type; when an item is opened inline (a browser
 * preview) the correct type is what makes the browser render it instead of
 * downloading it. Covers the common previewable types; anything unknown falls
 * back to application/octet-stream at the call site.
 */

const MIME_BY_EXTENSION: Record<string, string> = {
    pdf: "application/pdf",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    bmp: "image/bmp",
    avif: "image/avif",
    ico: "image/x-icon",
    mp4: "video/mp4",
    webm: "video/webm",
    mov: "video/quicktime",
    m4v: "video/x-m4v",
    ogv: "video/ogg",
    mp3: "audio/mpeg",
    wav: "audio/wav",
    flac: "audio/flac",
    aac: "audio/aac",
    ogg: "audio/ogg",
    oga: "audio/ogg",
    m4a: "audio/mp4",
    opus: "audio/opus",
    txt: "text/plain; charset=utf-8",
    md: "text/markdown; charset=utf-8",
    json: "application/json",
    xml: "application/xml",
    csv: "text/csv"
};

/** Best-effort MIME type for a filename, or undefined when unknown. */
export function mimeForName(name: string): string | undefined {
    const dot = name.lastIndexOf(".");
    if (dot < 0) return undefined;
    return MIME_BY_EXTENSION[name.slice(dot + 1).toLowerCase()];
}

/**
 * What an image actually is, read from its first bytes rather than from what
 * something said it was.
 *
 * Needed because a content type is a claim, and plenty of hosts do not make it:
 * Steam serves most Workshop preview pictures as `application/octet-stream`
 * because that is how they were stored, so a proxy that only forwarded declared
 * image types dropped most of them. Reading the bytes is both more permissive and
 * stricter - it lets those through, and it refuses a file that is not an image
 * whatever the header claimed.
 *
 * Deliberately only the four raster formats a preview can be. SVG is left out on
 * purpose: it is a document that can carry script, and nothing here should be able
 * to serve one.
 */
export function imageTypeOfBytes(bytes: Uint8Array): string | undefined {
    const starts = (...signature: number[]): boolean =>
        signature.every((byte, index) => bytes[index] === byte);
    // PNG, then JPEG, then GIF87a/GIF89a.
    if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
    if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
    if (starts(0x47, 0x49, 0x46, 0x38)) return "image/gif";
    // WebP is a RIFF container with WEBP four bytes into its payload.
    if (starts(0x52, 0x49, 0x46, 0x46) && [0x57, 0x45, 0x42, 0x50].every((byte, index) => bytes[8 + index] === byte)) {
        return "image/webp";
    }
    return undefined;
}
