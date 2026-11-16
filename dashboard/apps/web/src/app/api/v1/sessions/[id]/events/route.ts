/**
 * GET /api/v1/sessions/{id}/events - follow a session as Server-Sent Events.
 *
 * Every event and message after the cursor (the `Last-Event-ID` a reconnecting
 * client sends, or `?after`), oldest first, each framed with the cursor a reader
 * is at once it has it, so a dropped stream resumes with nothing sent twice and
 * nothing skipped. A `session` frame whenever the session itself changes, and an
 * `end` frame when it is over, after which the stream closes.
 *
 * Woken by the session's own change notice rather than a tight poll; a slow
 * poll covers a notice that never arrives. The stream closes itself after a
 * while so no connection is held forever; the client picks it up again.
 */

import * as sdk from "@polaris/sdk";
import * as core from "@polaris/core";
import { subscribeSession } from "@/lib/agents/session-live";
import { getSession } from "@/lib/agents/session-service";
import { queryOf } from "@/lib/deploy/api/http";
import { publicSession, streamAfter } from "@/lib/agents/session-api";
import { SessionApiRefusal, sessionApiRoute, sessionFor } from "@/lib/agents/session-api-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Changes that arrive together are read once. */
const COALESCE_MS = 250;
/** A read even when no notice came, for a notice lost on the way. */
const POLL_MS = 10_000;
/** A comment line so a proxy does not take a quiet stream for a dead one. */
const HEARTBEAT_MS = 25_000;
/** How long one connection is kept before the client is asked to come back. */
const LIFETIME_MS = 15 * 60_000;
/** How soon a client reconnects, in milliseconds. */
const RETRY_MS = 3_000;

function frame(type: string, cursor: sdk.StreamCursor, data: unknown): string {
    return `id: ${sdk.streamCursor(cursor)}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

export const GET = sessionApiRoute("agents.read", false, async (context) => {
    const first = await sessionFor(context);
    const query = sdk.sessionEventsQuery.parse(queryOf(context.url));
    const header = context.request.headers.get("last-event-id")?.trim() || null;
    let cursor: sdk.StreamCursor = { event: null, message: null };
    const resume = header ?? query.after ?? null;
    if (resume) {
        const read = sdk.readStreamCursor(resume);
        // i18n-ignore: API status bodies read by programs, in English like the rest of the API
        if (!read) throw new SessionApiRefusal(400, "Last-Event-ID: Not a stream cursor.");
        cursor = read;
    }
    const sessionId = first.id;
    const userId = context.principal.userId;
    const signal = context.request.signal;
    const encoder = new TextEncoder();
    let closed = false;
    let woke = false;
    let wake: (() => void) | null = null;
    const stop = () => {
        closed = true;
        wake?.();
    };

    const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
            const send = (text: string) => {
                if (!closed) controller.enqueue(encoder.encode(text));
            };
            const unsubscribe = subscribeSession(sessionId, () => {
                woke = true;
                wake?.();
            });
            signal.addEventListener("abort", stop, { once: true });
            const ends = Date.now() + LIFETIME_MS;
            let beat = Date.now();
            let shown = JSON.stringify(publicSession(first));
            send(`retry: ${RETRY_MS}\n`);
            send(frame("session", cursor, publicSession(first)));
            try {
                while (!closed && Date.now() < ends) {
                    // The state first, then the rows: a row written as the
                    // session ended is still sent before its end frame.
                    const now = await getSession(sessionId, userId);
                    if (!now) break;
                    for (;;) {
                        const page = await streamAfter(sessionId, cursor);
                        for (const { item, cursor: at } of page.items) {
                            cursor = at;
                            send(frame(item.type, cursor, item.data));
                        }
                        if (!page.more || closed) break;
                    }
                    const view = publicSession(now);
                    if (JSON.stringify(view) !== shown) {
                        shown = JSON.stringify(view);
                        send(frame("session", cursor, view));
                    }
                    if (core.isSessionOver(now.state)) {
                        send(frame("end", cursor, { state: now.state }));
                        break;
                    }
                    if (!woke) {
                        await new Promise<void>((resolve) => {
                            const timer = setTimeout(resolve, POLL_MS);
                            wake = () => {
                                clearTimeout(timer);
                                resolve();
                            };
                        });
                        wake = null;
                    }
                    if (woke) {
                        woke = false;
                        await new Promise((resolve) => setTimeout(resolve, COALESCE_MS));
                    }
                    if (Date.now() - beat >= HEARTBEAT_MS) {
                        send(": keep-alive\n\n");
                        beat = Date.now();
                    }
                }
            } catch (caught) {
                console.error(`polaris: session ${sessionId} event stream failed:`, caught);
            } finally {
                unsubscribe();
                signal.removeEventListener("abort", stop);
                closed = true;
                try {
                    controller.close();
                } catch {
                    // Already closed by the reader going away.
                }
            }
        },
        cancel: stop
    });

    return new Response(stream, {
        headers: {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-store, no-transform",
            connection: "keep-alive",
            // Sent as it is written, not held by a buffering proxy.
            "x-accel-buffering": "no"
        }
    });
});
