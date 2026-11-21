/**
 * A server-sent stream that only ever says "read again".
 *
 * The Time screen and the calendar grid both follow changes made by other
 * clients - a Stream Deck key, Companion, an assistant's tool, another tab or
 * device - the same way: the server wakes the tab, and the tab reads through the
 * route and the checks it always uses. A frame carries a sequence number and
 * nothing else, so it can never hand anybody a row.
 *
 * A burst of changes is one frame (`COALESCE_MS`), and a keep-alive comment
 * stops proxies from dropping an idle stream. Server-only.
 */

/** How long a burst is gathered before the tab is woken: a focus cycle's start
 *  and the deck's own re-read are one change to the person watching. */
const COALESCE_MS = 150;

/** Idle keep-alive. Proxies drop a stream that says nothing for long enough, and
 *  a comment frame is not delivered to the client as a message. */
const HEARTBEAT_MS = 25_000;

/**
 * Answer `request` with a stream that sends a frame shortly after `wake` is
 * called. `subscribe` is handed `wake` and answers the function that stops
 * listening; it is called once, and released when the client goes away.
 */
export function wakeStream(
    request: Request,
    subscribe: (wake: () => void) => () => void
): Response {
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

            unsubscribe = subscribe(() => {
                if (pending || closed) return;
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
