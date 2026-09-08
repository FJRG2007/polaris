/**
 * A change to a document: stored, and handed to everybody else editing it.
 *
 * A server action cannot outlive the page that called it, and the editor waits
 * a moment after the last keystroke before it saves - so a tab closed inside
 * that moment would lose whatever was typed in it. `sendBeacon` is the browser's
 * answer to exactly that, and it needs a plain endpoint to aim at.
 *
 * It carries the same bytes and takes the same path as the action: resolve the
 * caller, check they may write, store the update and the readable line beside
 * it. Nothing about a beacon is trusted that would not be trusted from a form.
 *
 * It is also the live path. Every update posted here is published to the other
 * tabs in the same document before the answer goes back, which is what makes two
 * people typing in one document see each other. That happens on this one route
 * rather than on a second so there is one place an update can enter a document -
 * a second entrance is a second access check to keep in step, and the one that
 * gets forgotten is the one somebody finds.
 */

import * as office from "@/lib/office/documents";
import { apiPermission } from "@/lib/api-session";
import { publishOfficeChange } from "@/lib/office/live";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A change is small; a request claiming to be one and being larger is not a
 *  keystroke, it is somebody using this to fill a disk. Generous enough for a
 *  paste of a whole document, which is the largest single change anybody
 *  actually makes. */
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

    // Which tab sent it, so that tab is not handed its own keystroke back.
    const origin = new URL(request.url).searchParams.get("origin") ?? "";

    try {
        await office.applyUpdate({ id: user.id }, id, body);
        // After the write, never before: an update the other side is shown and
        // this side failed to store is a document that disagrees with itself the
        // moment anybody reloads.
        publishOfficeChange({
            documentId: id,
            update: Buffer.from(body).toString("base64"),
            actorId: user.id,
            originId: origin
        });
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
