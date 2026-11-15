/**
 * GET /api/polar/code/board/live - a stream that says "read the board again"
 * whenever one of the running sessions it shows changes, its pull request
 * included (see `session-live.ts`).
 *
 * The sessions are the board's own, read here under the same filters and the
 * same reach, so the address names no ids. A session that starts after the
 * stream opened is not among them: the board reads itself again on a slow
 * timer as well, and reopens this stream when the sessions it shows change.
 */

import { BOARD_FILTERS } from "@/lib/agents/session-board";
import { liveBoardIds } from "@/lib/polar/code-board";
import { polarAccessFor } from "@/lib/polar/access";
import { subscribeSession } from "@/lib/agents/session-live";
import { readerWords } from "@/lib/i18n/reader-words";
import { backgroundUser, sessionCan } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A burst of hook reports across several sessions is one refresh. */
const COALESCE_MS = 750;
/** Proxies drop a stream that says nothing for long enough. */
const HEARTBEAT_MS = 25_000;

export async function GET(request: Request): Promise<Response> {
    const user = await backgroundUser();
    const allowed =
        user && (await polarAccessFor(user.id)).use && (await sessionCan(user, "agents.read"));
    const filters = BOARD_FILTERS.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    // A non-200 makes EventSource give up instead of reconnecting forever.
    if (!allowed || !filters.success)
        return Response.json(
            { error: (await readerWords("api"))("errors.unauthorized") },
            { status: allowed ? 400 : 401 }
        );
    const ids = await liveBoardIds(user.id, filters.data);

    const encoder = new TextEncoder();
    let closed = false;
    let pending: ReturnType<typeof setTimeout> | null = null;
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    const unsubscribes: Array<() => void> = [];
    const release = () => {
        closed = true;
        if (pending) clearTimeout(pending);
        if (heartbeat) clearInterval(heartbeat);
        for (const unsubscribe of unsubscribes.splice(0)) unsubscribe();
    };

    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            const send = (text: string) => {
                if (closed) return;
                try {
                    controller.enqueue(encoder.encode(text));
                } catch {
                    stop();
                }
            };
            const stop = () => {
                if (closed) return;
                release();
                try {
                    controller.close();
                } catch {
                    // Already closed by the client going away.
                }
            };
            const change = () => {
                if (pending) return;
                pending = setTimeout(() => {
                    pending = null;
                    send(`id: ${Date.now()}\nevent: change\ndata: {}\n\n`);
                }, COALESCE_MS);
            };
            for (const id of ids) unsubscribes.push(subscribeSession(id, change));
            heartbeat = setInterval(() => send(": keep-alive\n\n"), HEARTBEAT_MS);
            request.signal.addEventListener("abort", stop, { once: true });
            send(`retry: 5000\nid: ${Date.now()}\n\n`);
            if (request.headers.has("last-event-id")) change();
        },
        cancel() {
            release();
        }
    });

    return new Response(stream, {
        headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-store, no-transform",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no"
        }
    });
}
