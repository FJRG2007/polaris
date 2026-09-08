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
 *
 * Two kinds of caller reach it: an account with standing on the document, and a
 * browser carrying a pass an editing link gave it. Both are resolved by
 * `officeReader`, which asks the account first - somebody signed in AND holding
 * a viewer's link is still whatever their account makes them.
 */

import * as core from "@polaris/core";
import * as office from "@/lib/office/documents";
import { officeReader } from "@/lib/office/reader";
import { publishOfficeChange } from "@/lib/office/live";
import { resolveSession, sessionCan } from "@/lib/session";

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
    // A session is optional here and only here: a link is a way into one
    // document without one. When there IS a session it still has to hold the
    // app's own permission, so a link cannot be used to give somebody Office on
    // an instance whose administrator took it away from them.
    const session = await resolveSession();
    if (session && !(await sessionCan(session, "office.use"))) {
        return new Response("Forbidden", { status: 403 });
    }

    const { id } = await params;
    const reader = await officeReader(id, session?.id ?? null);
    if (!reader) return new Response("Forbidden", { status: 403 });
    if (!core.officeRoleAtLeast(reader.role, "editor")) {
        return new Response("Forbidden", { status: 403 });
    }

    const body = new Uint8Array(await request.arrayBuffer());
    if (body.length === 0) return new Response(null, { status: 204 });
    if (body.length > MAX_BYTES) return new Response("Too large", { status: 413 });

    // Which tab sent it, so that tab is not handed its own keystroke back.
    const origin = new URL(request.url).searchParams.get("origin") ?? "";

    try {
        // The permission is already decided above, for both kinds of caller, so
        // this is the write with the check taken off rather than a second check
        // that could disagree with the first.
        await office.writeUpdate(id, body, reader.userId);
        // After the write, never before: an update the other side is shown and
        // this side failed to store is a document that disagrees with itself the
        // moment anybody reloads.
        publishOfficeChange({
            documentId: id,
            update: Buffer.from(body).toString("base64"),
            actorId: reader.userId ?? "",
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
