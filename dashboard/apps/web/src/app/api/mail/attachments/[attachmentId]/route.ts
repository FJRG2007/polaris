/**
 * One file on a message in somebody's mailbox.
 *
 * Streamed from the mail server on demand rather than kept here. A mailbox's
 * attachments are already stored on the mail server, and copying every one of
 * them onto this disk to serve it once would make a mail client into a second
 * copy of everybody's mail. Saving one somewhere permanent is a deliberate
 * action with its own button.
 *
 * Authorized before a single byte is read: an attachment id in a URL is a
 * request, and being able to guess one must not be a way into somebody else's
 * mail. The lookup is narrowed by the caller's own id inside the query.
 *
 * By default everything is served as a download, and that is not laziness. This
 * is content from outside: an HTML part or an SVG rendered inline would be
 * somebody else's markup running on this origin, which is the oldest way there
 * is to steal a session. Pictures the message itself draws never come through
 * here - they are inside the message body, which is drawn in a sandboxed frame.
 *
 * `?inline=1` is for the viewer, which opens an attachment rather than saving
 * it, and it does not lift that rule so much as narrow it. Only the handful of
 * types a browser renders without being able to run anything get their real
 * content type - pictures that are not SVG, and audio and video. Everything else
 * stays an opaque download even in that mode, and every viewer Polaris has for
 * those reads the bytes itself and parses them: a spreadsheet, a document, a PDF
 * are all decoded in the page, so what the header says makes no difference to
 * them and every difference to what a browser will run.
 */

import { apiPermission } from "@/lib/api-session";
import { MailAccessError } from "@/lib/mailbox/access";
import { readAttachment } from "@/lib/mailbox/messages";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A filename, safe to put in a header. A name from outside can carry quotes and
 *  newlines, and a newline in a response header is a header somebody else
 *  wrote. */
function headerSafe(name: string): string {
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

export async function GET(
    request: Request,
    { params }: { params: Promise<{ attachmentId: string }> }
): Promise<Response> {
    const user = await apiPermission("mail.use");
    if (user instanceof Response) return user;
    const { attachmentId } = await params;
    const url = new URL(request.url);
    const inline = url.searchParams.get("inline") === "1";

    try {
        const file = await readAttachment(user.id, attachmentId);
        const name = headerSafe(file.name);
        const declared = (file.contentType ?? "").split(";")[0]?.trim() ?? "";
        // Only for a viewer, and only for what a browser draws rather than runs.
        const drawn = inline && DRAWN_INLINE.test(declared);
        return new Response(new Uint8Array(file.bytes), {
            headers: {
                "content-type": drawn ? declared : "application/octet-stream",
                "content-length": String(file.bytes.length),
                "content-disposition": `${drawn ? "inline" : "attachment"}; filename="${name}"; filename*=UTF-8''${encodeURIComponent(file.name)}`,
                "x-content-type-options": "nosniff",
                // Nothing in here may reach anything, whatever a browser decides
                // it is looking at.
                "content-security-policy": "default-src 'none'; sandbox",
                "cache-control": "private, no-store"
            }
        });
    } catch (caught) {
        // The same answer for "not there" and "not yours", so this cannot be
        // used to find out whether an id is a real one.
        if (caught instanceof MailAccessError) return new Response("Not found", { status: 404 });
        // Anything else is the mail server, and its words name hosts and paths.
        console.error("polaris: a mail attachment could not be read:", caught);
        return new Response("That file could not be fetched from the mail server.", { status: 502 });
    }
}
