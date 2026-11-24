/**
 * How a mail file is handed to the browser - an attachment on a message that
 * arrived, or one somebody uploaded into a message they are writing.
 *
 * One answer for both so the rules are the same: an opaque download unless the
 * viewer asked for it inline AND it is something a browser draws without being
 * able to run. See `api/mail/attachments/[attachmentId]`.
 */

import { downloadTicketHeaders } from "@/lib/download-ticket";

/** A filename, safe to put in a header. A name from outside can carry quotes and
 *  newlines, and a newline in a response header is a header somebody else
 *  wrote. */
export function headerSafe(name: string): string {
    return name.replace(/[\r\n"\\]/g, " ").slice(0, 200).trim() || "attachment";
}

/**
 * The types a browser draws and cannot run.
 *
 * SVG is not here and never will be: it is markup, and markup on this origin is
 * script. Neither is anything textual - a `text/plain` served inline is one
 * content-type sniff away from being treated as something else by a browser that
 * is trying to be helpful.
 */
const DRAWN_INLINE =
    /^(?:image\/(?:png|jpeg|gif|webp|avif|bmp)|video\/(?:mp4|webm|ogg)|audio\/(?:mpeg|mp4|ogg|wav|webm|flac))$/i;

/** The response for one file's bytes. */
export function mailFileResponse(
    request: Request,
    file: { name: string; contentType: string | null; bytes: Uint8Array },
    inline: boolean
): Response {
    const name = headerSafe(file.name);
    const declared = (file.contentType ?? "").split(";")[0]?.trim() ?? "";
    // Only for a viewer, and only for what a browser draws rather than runs.
    const drawn = inline && DRAWN_INLINE.test(declared);
    return new Response(new Uint8Array(file.bytes), {
        headers: {
            "content-type": drawn ? declared : "application/octet-stream",
            "content-length": String(file.bytes.length),
            // Says "this download has started" to the page that asked for it - see
            // `download-ticket`. Nothing at all when no ticket was sent.
            ...downloadTicketHeaders(request),
            "content-disposition": `${drawn ? "inline" : "attachment"}; filename="${name}"; filename*=UTF-8''${encodeURIComponent(file.name)}`,
            "x-content-type-options": "nosniff",
            // Nothing in here may reach anything, whatever a browser decides
            // it is looking at.
            "content-security-policy": "default-src 'none'; sandbox",
            "cache-control": "private, no-store"
        }
    });
}
