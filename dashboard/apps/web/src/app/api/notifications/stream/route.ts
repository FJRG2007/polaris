/**
 * Live notification feed. The connection stays open and the current list is
 * pushed whenever it changes, so the bell and the notifications page follow
 * along without a reload. Change detection is a server-side poll rather than an
 * in-process event bus because notifications are also written by background work
 * (scans, alarms, the network check); polling covers every producer with one
 * path. Node runtime for Prisma, and always scoped to the session user.
 */

import { resolveSession } from "@/lib/session";
import { listNotifications, NOTIFICATION_FEED_LIMIT } from "@/lib/notification-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** How often the feed is re-read. Fast enough to read as live, cheap enough to hold open. */
const POLL_MS = 5000;

export async function GET(request: Request): Promise<Response> {
    const session = await resolveSession();
    // A non-200 makes EventSource give up instead of reconnecting every few
    // seconds against a session that is gone.
    if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

    const userId = session.id;
    const encoder = new TextEncoder();
    let timer: ReturnType<typeof setInterval> | null = null;
    let closed = false;
    let previous = "";

    function stop(): void {
        closed = true;
        if (timer) clearInterval(timer);
        timer = null;
    }

    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            async function tick(): Promise<void> {
                if (closed) return;
                let payload: string;
                try {
                    payload = JSON.stringify({ items: await listNotifications(userId, NOTIFICATION_FEED_LIMIT) });
                } catch {
                    return; // Transient database error: hold the connection and retry.
                }
                if (closed) return;
                const changed = payload !== previous;
                previous = payload;
                try {
                    // An unchanged tick still writes a comment, which keeps proxies
                    // from dropping the idle connection.
                    controller.enqueue(encoder.encode(changed ? `data: ${payload}\n\n` : ":\n\n"));
                } catch {
                    stop();
                }
            }

            request.signal.addEventListener("abort", () => {
                stop();
                try {
                    controller.close();
                } catch {
                    // The client already went away.
                }
            });
            void tick();
            timer = setInterval(() => void tick(), POLL_MS);
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
