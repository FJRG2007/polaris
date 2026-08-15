/**
 * The live channel behind Chat.
 *
 * A tab holds this open and is told when a conversation it is in moved, so a
 * message appears without anybody pressing reload. Frames carry the channel id
 * and, for typing, a name - never the message. The tab pulls what changed
 * through the same service and the same access check that drew the channel, so
 * being told "something happened here" can never become being shown something
 * you are not in.
 *
 * Typing is not coalesced. Everything else is: a burst of messages is one wake,
 * because the tab answers a wake by asking for everything newer than what it
 * has, and doing that five times for five messages is four wasted round trips.
 *
 * Node runtime for Prisma, and never cached.
 */

import { subscribeChatChanges } from "@/lib/chat/live";
import { reachableChannelIds } from "@/lib/chat/access";
import { resolveSession, sessionCan } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** How long a burst is gathered before the tab is woken. Shorter than Tasks
 *  uses: a message that lands half a second late reads as a laggy chat, and a
 *  chat that feels laggy is one people stop using. */
const COALESCE_MS = 120;

/** How long the reachable set is trusted. Short, because it is the thing
 *  standing between a private channel and somebody who was just removed from
 *  it, and because being added to one should start delivering almost at once. */
const SCOPE_TTL_MS = 10_000;

/** Idle keep-alive. Proxies drop a stream that says nothing for long enough, and
 *  a comment frame is not delivered to the client as a message. */
const HEARTBEAT_MS = 25_000;

export async function GET(request: Request): Promise<Response> {
    const session = await resolveSession();
    // A non-200 makes EventSource give up rather than reconnect every few
    // seconds against a session that is gone.
    if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
    if (!(await sessionCan(session, "chat.use"))) {
        return Response.json({ error: "Forbidden" }, { status: 403 });
    }

    const actor = { id: session.id };
    const encoder = new TextEncoder();

    let unsubscribe: (() => void) | null = null;
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    let pending: ReturnType<typeof setTimeout> | null = null;
    let closed = false;
    let sequence = 0;

    /** The channels this reader is in, as of when they were last resolved. */
    let reachable = new Set<string>();
    let resolvedAt = 0;
    let resolving: Promise<void> | null = null;
    /** Which channels moved since the last wake, so one frame can name them all
     *  and the tab only refetches the ones it is actually showing. */
    let moved = new Set<string>();

    async function resolveReachable(): Promise<void> {
        reachable = await reachableChannelIds(actor);
        resolvedAt = Date.now();
    }

    /** Re-resolve at most one query at a time, and never more often than the TTL. */
    function refreshReachable(): Promise<void> {
        if (resolving) return resolving;
        resolving = resolveReachable()
            .catch(() => {
                // A transient database error leaves the previous answer in
                // place; the next event past the TTL tries again.
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

            function send(payload: unknown): void {
                write(`data: ${JSON.stringify(payload)}\n\n`);
            }

            /** Wake the tab once, however many messages arrived in the window. */
            function wake(channelId: string): void {
                moved.add(channelId);
                if (closed || pending) return;
                pending = setTimeout(() => {
                    pending = null;
                    sequence += 1;
                    send({ kind: "posted", seq: sequence, channels: [...moved] });
                    moved = new Set();
                }, COALESCE_MS);
            }

            await refreshReachable();

            unsubscribe = subscribeChatChanges((change) => {
                if (closed) return;

                // A change about who is in what is not about a channel this
                // reader necessarily reaches yet - being added is exactly the
                // case - so the audience decides, and the set is re-resolved.
                if (change.kind === "channels") {
                    const forThem = !change.audience || change.audience.includes(actor.id);
                    if (!forThem && !reachable.has(change.channelId)) return;
                    resolvedAt = 0;
                    void refreshReachable().then(() => {
                        if (!closed) send({ kind: "channels" });
                    });
                    return;
                }

                // Their own writing already settled in the tab that did it.
                if (change.actorId === actor.id) return;

                if (reachable.has(change.channelId)) {
                    if (change.kind === "call") {
                        // Never coalesced. A call frame is not "something
                        // changed, go and look" - it is what makes a browser
                        // ring, and a ring that arrives after the caller gave
                        // up is worse than none.
                        if (change.call) {
                            send({
                                kind: "call",
                                channelId: change.channelId,
                                meetingId: change.call.meetingId,
                                state: change.call.state,
                                count: change.call.count,
                                userId: change.actorId,
                                name: change.actorName ?? ""
                            });
                        }
                        return;
                    }
                    if (change.kind === "typing") {
                        send({
                            kind: "typing",
                            channelId: change.channelId,
                            userId: change.actorId,
                            name: change.actorName ?? ""
                        });
                    } else {
                        wake(change.channelId);
                    }
                    return;
                }

                // An unfamiliar channel is usually somebody else's. Re-ask once
                // the TTL is up, in case it is one they were just added to.
                if (Date.now() - resolvedAt < SCOPE_TTL_MS) return;
                const channelId = change.channelId;
                const kind = change.kind;
                void refreshReachable().then(() => {
                    if (!closed && kind === "posted" && reachable.has(channelId)) wake(channelId);
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
