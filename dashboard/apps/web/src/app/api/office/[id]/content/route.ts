/**
 * The last write of a document, sent as the tab closes.
 *
 * A server action cannot outlive the page that called it, and the editor waits
 * a moment after the last keystroke before it saves - so a tab closed inside
 * that moment would lose whatever was typed in it. `sendBeacon` is the browser's
 * answer to exactly that, and it needs a plain endpoint to aim at.
 *
 * It carries the same bytes and takes the same path as the action: resolve the
 * caller, check they may write, store the update and the readable line beside
 * it. Nothing about a beacon is trusted that would not be trusted from a form.
 */

import * as office from "@/lib/office/documents";
import { apiPermission } from "@/lib/api-session";
import { excerptOf, openDocument } from "@/lib/office/content";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A document is large; a request claiming to be one and being larger is not a
 *  save, it is somebody using this to fill a disk. */
const MAX_BYTES = 8 * 1024 * 1024;

export async function POST(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
    const user = await apiPermission("office.use");
    if (user instanceof Response) return user;

    const { id } = await params;
    const body = new Uint8Array(await request.arrayBuffer());
    if (body.length === 0) return new Response(null, { status: 204 });
    if (body.length > MAX_BYTES) return new Response("Too large", { status: 413 });

    try {
        await office.saveContent({ id: user.id }, id, body, excerptOf(openDocument(body)));
    } catch (caught) {
        if (caught instanceof office.OfficeAccessError) {
            return new Response("Forbidden", { status: 403 });
        }
        throw caught;
    }
    // A beacon's answer is never read. Nothing is returned but the fact that it
    // landed.
    return new Response(null, { status: 204 });
}
