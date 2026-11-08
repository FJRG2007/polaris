/**
 * GET /api/agents/sessions/:id/live - a stream that says "read the session
 * again" whenever it changes in this process.
 *
 * Frames carry nothing; the page answers one with a refresh, which reads the
 * session through the same checks as its first render. Same reader rule as the
 * page: the owner, or somebody it was shared with.
 */

import { backgroundUser, sessionCan } from "@/lib/session";
import { getSession, sharedSession } from "@/lib/agents/session-service";
import { subscribeSession } from "@/lib/agents/session-live";
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
                try {
                    controller.close();
                } catch {
                    // Already closed by the client going away.
                }
            };
            unsubscribe = subscribeSession(id, () => {
                if (pending) return;
                pending = setTimeout(() => {
                    pending = null;
                    send("event: change\ndata: {}\n\n");
                }, COALESCE_MS);
            });
            heartbeat = setInterval(() => send(": keep-alive\n\n"), HEARTBEAT_MS);
            request.signal.addEventListener("abort", stop, { once: true });
            send("retry: 5000\n\n");
        },
        cancel() {
            closed = true;
            if (pending) clearTimeout(pending);
            if (heartbeat) clearInterval(heartbeat);
            unsubscribe?.();
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
