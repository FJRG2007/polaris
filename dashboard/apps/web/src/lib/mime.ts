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
