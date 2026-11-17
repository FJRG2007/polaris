/**
 * GET /api/agents/sessions/:id/live - a stream that says "read the session
 * again" whenever it changes, in this process or any other (see
 * `session-live.ts`).
 *
 * Frames carry nothing; the page answers one with a refresh, which reads the
 * session through the same checks as its first render. Same reader rule as the
 * page: the owner, or somebody it was shared with.
 *
 * Every frame has an id, so a browser that lost the stream (a phone that slept,
 * a proxy that dropped it) reconnects with `Last-Event-ID`. That reconnect is
 * answered with one change straight away: whatever moved while it was away is
 * read rather than waited for.
 *
 * Beside the changes, a `draft` frame carries the agent's message while it is
 * being written (`session-drafts.ts`): what was added to it, never stored, so
 * the page draws the answer as it comes. A stream that opens part way through
 * a message is sent it whole first.
 */

import { backgroundUser, sessionCan } from "@/lib/session";
import { getSession, sharedSession } from "@/lib/agents/session-service";
import { subscribeSession } from "@/lib/agents/session-live";
import { currentDraft, subscribeDraft } from "@/lib/agents/session-drafts";
import type { DraftFrame } from "@/lib/agents/draft-frames";
import { readerWords } from "@/lib/i18n/reader-words";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A burst of hook reports is one refresh. */
const COALESCE_MS = 400;
/** Proxies drop a stream that says nothing for long enough. */
const HEARTBEAT_MS = 25_000;

export async function GET(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
    const { id } = await params;
    const user = await backgroundUser();
    const readable =
        user &&
        (await sessionCan(user, "agents.read")) &&
        ((await getSession(id, user.id)) ?? (await sharedSession(id, user.id)));
    // A non-200 makes EventSource give up instead of reconnecting forever.
    if (!readable)
        return Response.json(
            { error: (await readerWords("api"))("errors.unauthorized") },
            { status: 401 }
        );

    const encoder = new TextEncoder();
    let closed = false;
    let pending: ReturnType<typeof setTimeout> | null = null;
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    let unsubscribe: (() => void) | null = null;
    let unsubscribeDraft: (() => void) | null = null;

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
                closed = true;
                if (pending) clearTimeout(pending);
                if (heartbeat) clearInterval(heartbeat);
                unsubscribe?.();
                unsubscribeDraft?.();
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
            unsubscribe = subscribeSession(id, change);
            // No id: a draft is not something a reconnect has to catch up on.
            const draft = (frame: DraftFrame) => send(`event: draft\ndata: ${JSON.stringify(frame)}\n\n`);
            unsubscribeDraft = subscribeDraft(id, draft);
            heartbeat = setInterval(() => send(": keep-alive\n\n"), HEARTBEAT_MS);
            request.signal.addEventListener("abort", stop, { once: true });
            // The id is set even by a frame without data, so a stream dropped
            // before its first change still comes back as a reconnect.
            send(`retry: 5000\nid: ${Date.now()}\n\n`);
            if (request.headers.has("last-event-id")) change();
            const writing = currentDraft(id);
            if (writing) draft(writing);
        },
        cancel() {
            closed = true;
            if (pending) clearTimeout(pending);
            if (heartbeat) clearInterval(heartbeat);
            unsubscribe?.();
            unsubscribeDraft?.();
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
