/**
 * The live channel behind the Tasks app. A tab holds this open and is told when
 * work it can see moved, so a task somebody else creates, assigns, drags or
 * deletes appears without anybody pressing reload.
 *
 * The frame carries a sequence number and nothing else. The browser answers it
 * by re-rendering the route it is already on, which re-runs the same server
 * components and the same access checks that drew it in the first place - so
 * being told "something changed" can never turn into being shown something you
 * may not read. It also means every screen the app has follows along without one
 * of them needing its own payload format.
 *
 * Node runtime for Prisma, and never cached.
 */

import { subscribeTaskChanges } from "@/lib/tasks/live";
import { resolveSession, sessionCan } from "@/lib/session";
import { visibleScope, type TaskActor } from "@/lib/tasks/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * How long a burst of changes is gathered before the tab is woken. A drag that
 * reorders twenty rows, a bulk edit over a selection and an automation reacting
 * to either are all one change to the person watching, and re-rendering once is
 * both cheaper and steadier to look at than twenty times.
 */
const COALESCE_MS = 400;

/** How long a resolved scope is trusted before a change in an unfamiliar space
 *  makes it worth asking again. Short enough that being added to a space starts
 *  delivering almost at once, long enough that unrelated traffic in a busy
 *  instance does not re-resolve on every event. */
const SCOPE_TTL_MS = 15_000;

/** Idle keep-alive. Proxies drop a stream that says nothing for long enough, and
 *  a comment frame is not delivered to the client as a message. */
const HEARTBEAT_MS = 25_000;

export async function GET(request: Request): Promise<Response> {
    const session = await resolveSession();
    // A non-200 makes EventSource give up rather than reconnect every few seconds
    // against a session that is gone.
    if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
    if (!(await sessionCan(session, "tasks.read"))) {
        return Response.json({ error: "Forbidden" }, { status: 403 });
    }

    const actor: TaskActor = { id: session.id, isAdmin: session.isAdmin };
    const encoder = new TextEncoder();

    let unsubscribe: (() => void) | null = null;
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    let pending: ReturnType<typeof setTimeout> | null = null;
    let closed = false;
    let sequence = 0;

    // The spaces this reader reaches, as of when they were last resolved. Cached
    // because an event arriving for a space they have nothing to do with is the
    // common case and must not cost a query.
    let reachable = new Set<string>();
    let resolvedAt = 0;
    let resolving: Promise<void> | null = null;

    async function resolveReachable(): Promise<void> {
        const scope = await visibleScope(actor);
        reachable = new Set([...scope.spaceIds, ...scope.partialSpaceIds]);
        resolvedAt = Date.now();
    }

    /** Re-resolve at most one query at a time, and never more often than the TTL. */
    function refreshReachable(): Promise<void> {
        if (resolving) return resolving;
        resolving = resolveReachable()
            .catch(() => {
                // A transient database error leaves the previous answer in place;
                // the next event past the TTL tries again.
            })
            .finally(() => {
                resolving = null;
            });
        return resolving;
    }

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
        async start(controller) {
            function write(frame: string): void {
                if (closed) return;
                try {
                    controller.enqueue(encoder.encode(frame));
                } catch {
                    stop();
                }
            }

            /** Wake the tab, once, however many changes arrived in the window. */
            function wake(): void {
                if (closed || pending) return;
                pending = setTimeout(() => {
                    pending = null;
                    sequence += 1;
                    write(`data: ${JSON.stringify({ seq: sequence })}\n\n`);
                    // What they can see may be exactly what just changed, so the
                    // next event is judged against a fresh answer rather than the
                    // membership this connection opened with.
                    resolvedAt = 0;
                }, COALESCE_MS);
            }

            await refreshReachable();

            unsubscribe = subscribeTaskChanges((change) => {
                if (closed) return;
                // Their own write already revalidated in the action that made it.
                if (change.actorId === actor.id) return;
                if (!change.spaceId) {
                    wake();
                    return;
                }
                if (reachable.has(change.spaceId)) {
                    wake();
                    return;
                }
                // An unfamiliar space is usually somebody else's. It is also what
                // being added to one looks like, so a stale answer is worth
                // re-asking once the TTL is up.
                if (Date.now() - resolvedAt < SCOPE_TTL_MS) return;
                const spaceId = change.spaceId;
                void refreshReachable().then(() => {
                    if (!closed && reachable.has(spaceId)) wake();
                });
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
