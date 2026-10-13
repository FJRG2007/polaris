/**
 * The start of one document, for its tile on the Office home - see
 * `lib/office/preview`.
 *
 * Only for an account that can open the document: the same `readDocument` the
 * editor reads through, behind the app's own permission. A link visitor has no
 * home to draw a tile on, so a link is not a way in here.
 *
 * Asked with the time the document last changed in the address, so the browser
 * may keep the answer: an edit asks a new address and nothing stale is shown.
 */

import { z } from "zod";
import { previewDocument } from "@/lib/office/export";
import { readDocument } from "@/lib/office/documents";
import { backgroundUser, sessionCan } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const idSchema = z.string().uuid();

export async function GET(
    _request: Request,
    { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
    const session = await backgroundUser();
    if (!session) return new Response("Unauthorized", { status: 401 });
    if (!(await sessionCan(session, "office.use"))) {
        return new Response("Forbidden", { status: 403 });
    }

    const parsed = idSchema.safeParse((await params).id);
    if (!parsed.success) return new Response("Not found", { status: 404 });
    const found = await readDocument(session, parsed.data);
    if (!found) return new Response("Not found", { status: 404 });

    return Response.json(previewDocument(found.view.kind, found.content), {
        // Private to this reader; the address changes when the document does.
        headers: { "cache-control": "private, max-age=3600" }
    });
}
