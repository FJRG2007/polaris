/**
 * Downloading writing as a folder of Markdown.
 *
 * A route rather than a server action because what comes back is a file: an
 * action returns a value into the page, and handing somebody a zip means the
 * browser has to do the downloading. It is a GET so the link can be an ordinary
 * link, which is also what makes it work from the right-click menu without any
 * of the machinery a form post would need.
 *
 * Authorization is the app's own, not the route being unguarded: `notes.use` to
 * be here at all, and then `lib/notes/access` on the exact thing being asked
 * for. An export reads a whole shelf at once, so the check has to be the same
 * one every other read makes rather than a looser one written for a download.
 */

import { requirePermission } from "@/lib/session";
import { NoteAccessError } from "@/lib/notes/access";
import { exportArchive, type ExportScope } from "@/lib/notes/export-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
    const user = await requirePermission("notes.use");
    const url = new URL(request.url);
    const kind = url.searchParams.get("scope");
    const id = url.searchParams.get("id");

    let scope: ExportScope;
    if (kind === "note" && id) scope = { kind: "note", id };
    else if (kind === "folder" && id) scope = { kind: "folder", id };
    else if (kind === "space") scope = { kind: "space", id: id || null };
    else return Response.json({ error: "Say what to export" }, { status: 400 });

    try {
        const archive = await exportArchive({ id: user.id, isAdmin: user.isAdmin }, scope);
        return new Response(archive.bytes as BodyInit, {
            headers: {
                "content-type": "application/zip",
                // The quoted form, because a notebook is allowed to be called
                // "Q3 planning" and an unquoted header stops at the space.
                "content-disposition": `attachment; filename="${archive.name.replace(/"/g, "")}"`,
                "cache-control": "no-store"
            }
        });
    } catch (caught) {
        if (caught instanceof NoteAccessError) {
            return Response.json({ error: caught.message }, { status: 403 });
        }
        // No detail: this answers an authenticated caller, but the failure could
        // name a path or a row nobody asked to have published.
        console.error("polaris: a notes export failed:", caught);
        return Response.json({ error: "That could not be exported" }, { status: 500 });
    }
}
