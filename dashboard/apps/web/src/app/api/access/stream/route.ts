/**
 * The live channel behind what a reader may reach.
 *
 * A tab holds this open and is woken when the permissions behind its own
 * screens change, so an app granted or taken back appears and disappears
 * without anybody pressing reload. Frames carry no detail at all: the tab
 * answers one by asking the server for the page again, which resolves what it
 * may see exactly as the first render did.
 *
 * The filter is one line and it is the whole of the access story: a frame
 * naming particular people is delivered only to them. A frame naming nobody is
 * a role, a policy or an app - which is everybody's business, and still tells
 * the tab nothing it could not already see.
 *
 * Node runtime for Prisma, and never cached.
 */

import { resolveSession } from "@/lib/session";
import { concerns, subscribeAccess } from "@/lib/access-live";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** How long a burst is gathered before the tab is woken. An administrator
 *  moving somebody between roles is several writes in a row and one redraw. */
const COALESCE_MS = 300;

/** Idle keep-alive. Proxies drop a stream that says nothing for long enough, and
 *  a comment frame is not delivered to the client as a message. */
const HEARTBEAT_MS = 25_000;

export async function GET(request: Request): Promise<Response> {
    const session = await resolveSession();
    // A non-200 makes EventSource give up rather than reconnect every few
    // seconds against a session that is gone.
    if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

    // Held rather than read off `session` inside the closures: the narrowing
    // above does not survive into a callback.
    const readerId = session.id;
    const encoder = new TextEncoder();
    let unsubscribe: (() => void) | null = null;
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    let pending: ReturnType<typeof setTimeout> | null = null;
    let closed = false;
    let sequence = 0;

    function stop(): void {
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        if (pending) clearTimeout(pending);
        heartbeat = null;
        pending = null;
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

            function wake(): void {
                if (closed || pending) return;
                pending = setTimeout(() => {
                    pending = null;
                    sequence += 1;
                    // A sequence and nothing else. What changed is answered by
                    // the page the tab then asks for.
                    write(`data: ${JSON.stringify({ kind: "access", seq: sequence })}\n\n`);
                }, COALESCE_MS);
            }

            unsubscribe = subscribeAccess((change) => {
                if (closed || !concerns(change, readerId)) return;
                wake();
            });

            request.signal.addEventListener("abort", () => {
                stop();
                try {
                    controller.close();
                } catch {
                    // The client already went away.
                }
            });

            // An opening comment gets the response on the wire, which is what
            // makes EventSource fire `open` instead of sitting in `connecting`.
            write(":ok\n\n");
            heartbeat = setInterval(() => write(":\n\n"), HEARTBEAT_MS);
        },
        cancel() {
            stop();
        }
    });

    return new Response(stream, {
        headers: {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-store, no-transform",
            connection: "keep-alive",
            // Tells nginx-style proxies not to buffer the stream.
            "x-accel-buffering": "no"
        }
    });
}
