/**
 * The live channel behind one open document.
 *
 * A tab holds this open and is handed every change anybody else makes to the
 * same document, as it is made. Unlike Chat's stream, the frames carry the
 * content itself - a Yjs update - because the whole point of a shared document
 * is that the other side sees the letter within a frame or two, and a round trip
 * per keystroke is not that.
 *
 * That makes **the connection the access check**, not a filter on top of one.
 * The document is resolved once, here, before a single frame is written; the
 * stream is opened for that one document and every frame is matched against it.
 * A browser cannot ask for a second document on a connection it opened for the
 * first.
 *
 * A tab is never handed its own updates back. Applying your own keystroke into
 * your own editor is how a caret ends up jumping to the end of the line, and the
 * origin is the tab rather than the account: one person with a laptop and a
 * phone is two editors that each have to hear the other.
 *
 * Node runtime, and never cached.
 */

import { officeReader } from "@/lib/office/reader";
import { subscribeOfficeChanges } from "@/lib/office/live";
import { resolveSession, sessionCan } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Idle keep-alive. Proxies drop a stream that says nothing for long enough, and
 *  a comment frame is not delivered to the client as a message. */
const HEARTBEAT_MS = 25_000;

export async function GET(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
    // Optional, because a link is a way into one document without a session.
    // When there is one it still has to hold the app's own permission.
    const session = await resolveSession();
    if (session && !(await sessionCan(session, "office.use"))) {
        return Response.json({ error: "Forbidden" }, { status: 403 });
    }

    const { id } = await params;
    // Resolved once, before anything is written. Everything below is inside this
    // answer, which is why nothing below re-checks it. A non-200 makes
    // EventSource give up rather than reconnect every few seconds against
    // something that is not going to start working.
    const reader = await officeReader(id, session?.id ?? null);
    if (!reader) {
        return Response.json({ error: session ? "Forbidden" : "Unauthorized" }, {
            status: session ? 403 : 401
        });
    }

    // The tab that opened this. Named by the browser so two tabs of one account
    // can tell each other apart; used only to keep a tab from hearing its own
    // typing, so a made-up one costs its owner an echo and nobody else anything.
    const origin = new URL(request.url).searchParams.get("origin") ?? "";
    // "" for somebody on a link, who has no account to be. Only used to keep a
    // tab from hearing its own typing.
    const readerId = reader.userId ?? "";
    const encoder = new TextEncoder();
    let unsubscribe: (() => void) | null = null;
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    let closed = false;

    function stop(): void {
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        heartbeat = null;
        unsubscribe?.();
        unsubscribe = null;
    }

    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            function write(frame: string): void {
                if (closed) return;
                try {
                    controller.enqueue(encoder.encode(frame));
                } catch {
                    stop();
                }
            }

            // Said once, so a tab knows it is connected rather than merely not
            // having heard anything yet.
            write(`data: ${JSON.stringify({ kind: "open", role: reader.role })}\n\n`);

            unsubscribe = subscribeOfficeChanges((change) => {
                if (closed) return;
                if (change.documentId !== id) return;
                // Its own typing, coming back. See the note at the top.
                if (change.originId && change.originId === origin) return;
                write(
                    `data: ${JSON.stringify({
                        kind: "update",
                        update: change.update,
                        actorId: change.actorId === readerId ? "" : change.actorId
                    })}\n\n`
                );
            });

            heartbeat = setInterval(() => write(": ping\n\n"), HEARTBEAT_MS);
            request.signal.addEventListener("abort", stop);
        },
        cancel() {
            stop();
        }
    });

    return new Response(stream, {
        headers: {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "private, no-store, no-transform",
            connection: "keep-alive",
            // Nginx buffers an event stream into uselessness without this.
            "x-accel-buffering": "no"
        }
    });
}
