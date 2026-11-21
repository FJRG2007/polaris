/**
 * The word that the reader's alarms, timers or stopwatch changed, pushed the
 * moment any client changes them - a Stream Deck key, Companion, an assistant's
 * tool, another tab or device - so an open Time screen follows without a reload.
 *
 * A frame carries a sequence number and nothing else: the tab answers it by
 * reading `/api/calendar/time` again, through the same session and checks.
 * Scoped to the session for the connection's whole life.
 */

import { apiCalendarUser } from "../../../../../lib/access";
import { onClockChanged } from "../../../../../lib/clock/live";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** How long a burst is gathered before the tab is woken: a focus cycle's start
 *  and the deck's own re-read are one change to the person watching. */
const COALESCE_MS = 150;

/** Idle keep-alive. Proxies drop a stream that says nothing for long enough, and
 *  a comment frame is not delivered to the client as a message. */
const HEARTBEAT_MS = 25_000;

export async function GET(request: Request): Promise<Response> {
    // A non-200 makes EventSource give up rather than reconnect every few
    // seconds against a session that is gone.
    const user = await apiCalendarUser();
    if (user instanceof Response) return user;

    const encoder = new TextEncoder();
    let unsubscribe: (() => void) | null = null;
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    let pending: ReturnType<typeof setTimeout> | null = null;
    let closed = false;
    let sequence = 0;

    function stop(): void {
        closed = true;
        unsubscribe?.();
        unsubscribe = null;
        if (heartbeat) clearInterval(heartbeat);
        if (pending) clearTimeout(pending);
        heartbeat = null;
        pending = null;
    }

    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            const send = (chunk: string): void => {
                if (closed) return;
                try {
                    controller.enqueue(encoder.encode(chunk));
                } catch {
                    stop();
                }
            };

            request.signal.addEventListener("abort", () => {
                stop();
                try {
                    controller.close();
                } catch {
                    // The client already went away.
                }
            });

            unsubscribe = onClockChanged((userId) => {
                if (userId !== user.id || pending || closed) return;
                pending = setTimeout(() => {
                    pending = null;
                    sequence += 1;
                    send(`data: ${sequence}\n\n`);
                }, COALESCE_MS);
            });
            // How soon a dropped stream is tried again. The tab reads once on
            // every reconnect, for whatever it missed while it was away.
            send("retry: 5000\n\n");
            heartbeat = setInterval(() => send(":\n\n"), HEARTBEAT_MS);
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
