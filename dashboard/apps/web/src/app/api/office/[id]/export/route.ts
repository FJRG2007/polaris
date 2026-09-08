/**
 * A document, downloaded as something else.
 *
 * Reached by an ordinary link with `download` on it, because that is what a
 * browser does best: a file starts saving with no page transition and no blob
 * held in memory on the way.
 *
 * The caller is resolved the same way the content and stream routes resolve
 * theirs - an account with standing, or a browser carrying a pass a link gave
 * it - through the one function all three share. A viewer may export, and that
 * is deliberate: reading a document and keeping a copy of what you read are the
 * same act, and a format that refused it would only be teaching people to
 * screenshot.
 *
 * Served as a download with nothing allowed to run, whatever the format claims
 * to be. An export is the document's own content, and a document is written by
 * whoever wrote it - an HTML export rendered on this origin would be their
 * markup on somebody else's session.
 */

import * as core from "@polaris/core";
import { officeReader } from "@/lib/office/reader";
import { readByLink } from "@/lib/office/documents";
import { exportDocument } from "@/lib/office/export";
import { resolveSession, sessionCan } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A filename, safe to put in a header: a name from outside can carry quotes and
 *  newlines, and a newline in a response header is a header somebody else
 *  wrote. `exportFilename` has already reduced it; this is the second pair of
 *  hands on the one string that leaves through a header. */
function headerSafe(name: string): string {
    return (
        name
            .replace(/[\r\n"\\]/g, " ")
            .slice(0, 200)
            .trim() || "document"
    );
}

export async function GET(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
    // Optional, because a link is a way into one document without a session.
    // When there is one it still has to hold the app's own permission.
    const session = await resolveSession();
    if (session && !(await sessionCan(session, "office.use"))) {
        return new Response("Forbidden", { status: 403 });
    }

    const { id } = await params;
    const reader = await officeReader(id, session?.id ?? null);
    if (!reader) return new Response("Not found", { status: 404 });

    const format = new URL(request.url).searchParams.get("as") ?? "";
    const found = await readByLink(id);
    if (!found) return new Response("Not found", { status: 404 });

    // Refused rather than answered with an empty file of the wrong kind. The
    // menu is built from the same table, so this is only reachable by editing
    // the address - but a menu is not a guard.
    if (!core.canExportAs(found.kind, format)) {
        return new Response("That is not a format this document has.", { status: 400 });
    }

    const file = await exportDocument(found.kind, found.title, found.content, format);
    if (!file) {
        return new Response("That format is made in the browser, not here.", { status: 400 });
    }

    const name = headerSafe(file.filename);
    return new Response(new Uint8Array(file.bytes), {
        headers: {
            "content-type": file.contentType,
            "content-length": String(file.bytes.length),
            "content-disposition": `attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
            "x-content-type-options": "nosniff",
            "content-security-policy": "default-src 'none'; sandbox",
            "cache-control": "private, no-store"
        }
    });
}
