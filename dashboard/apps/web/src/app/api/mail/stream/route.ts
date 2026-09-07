/**
 * The live channel behind Mail.
 *
 * A tab holds this open and is told when one of its own mailboxes moved, so mail
 * that arrives on the server appears without anybody pressing reload. Frames
 * carry the mailbox and the folder and nothing else - never a subject, never an
 * address, never a message. The tab answers a frame by asking for the list
 * again, through the same service and the same ownership check that drew it.
 *
 * The filter is one line and it is the whole of the access story: a frame is
 * delivered only when the mailbox it names belongs to the reader. That set is
 * resolved once at the start and re-resolved on a change, because a person's own
 * mailboxes change when they add or remove one and at no other time.
 *
 * Bursts are coalesced. A sync that files forty arriving messages is one wake,
 * because the tab answers a wake by asking for everything again and doing that
 * forty times is thirty-nine wasted round trips.
 *
 * Node runtime for Prisma, and never cached.
 */

import { subscribeMail } from "@/lib/mailbox/live";
import { watchMailboxes } from "@/lib/mailbox/watch";
import { ownedAccountIds } from "@/lib/mailbox/access";
import { resolveSession, sessionCan } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** How long a burst is gathered before the tab is woken. Longer than the chat's,
 *  because nobody watches mail arrive keystroke by keystroke and a sync that
 *  files a page of messages should be one redraw. */
const COALESCE_MS = 400;

/** How long the set of the reader's own mailboxes is trusted. It only changes
 *  when they add or remove one, which they did in this same tab. */
const SCOPE_TTL_MS = 30_000;

/** Idle keep-alive. Proxies drop a stream that says nothing for long enough, and
 *  a comment frame is not delivered to the client as a message. */
const HEARTBEAT_MS = 25_000;

export async function GET(request: Request): Promise<Response> {
    const session = await resolveSession();
    // A non-200 makes EventSource give up rather than reconnect every few
    // seconds against a session that is gone.
    if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
    if (!(await sessionCan(session, "mail.use"))) {
        return Response.json({ error: "Forbidden" }, { status: 403 });
    }

    // Held rather than re-read off `session` inside the closures: the narrowing
    // above does not survive into a callback.
    const readerId = session.id;
    const encoder = new TextEncoder();
    let unsubscribe: (() => void) | null = null;
    /** Stops this tab counting as somebody watching. */
    let unwatch: (() => void) | null = null;
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    let pending: ReturnType<typeof setTimeout> | null = null;
    let closed = false;
    let sequence = 0;

    let mine = new Set<string>();
    let resolvedAt = 0;
    let resolving: Promise<void> | null = null;
    /** Which mailboxes moved since the last wake, so one frame names them all. */
    let moved = new Set<string>();

    async function resolveMine(): Promise<void> {
        mine = new Set(await ownedAccountIds(readerId));
        resolvedAt = Date.now();
    }

    function refreshMine(): Promise<void> {
        if (resolving) return resolving;
        resolving = resolveMine()
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
        unwatch?.();
        unwatch = null;
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

            function wake(accountId: string): void {
                moved.add(accountId);
                if (closed || pending) return;
                pending = setTimeout(() => {
                    pending = null;
                    sequence += 1;
                    send({ kind: "mail", seq: sequence, accounts: [...moved] });
                    moved = new Set();
                }, COALESCE_MS);
            }

            await refreshMine();

            // Somebody is looking at their mail. That is what makes their
            // mailboxes worth asking every twenty seconds instead of every five
            // minutes, and it lasts exactly as long as this stream does.
            unwatch = watchMailboxes(readerId);

            unsubscribe = subscribeMail((change) => {
                if (closed) return;
                // A queued message changing state is what the composer's own tab
                // is waiting for, so it is never coalesced and never skipped for
                // being this person's own doing: the tab that pressed Send is
                // exactly the one that has to stop counting down.
                if (change.kind === "sending") {
                    if (!mine.has(change.accountId)) return;
                    send({ kind: "sending", accountId: change.accountId });
                    return;
                }
                if (mine.has(change.accountId)) {
                    wake(change.accountId);
                    return;
                }
                // A mailbox this reader does not know about is usually somebody
                // else's. Re-ask once the TTL is up, in case it is one they have
                // just added.
                if (Date.now() - resolvedAt < SCOPE_TTL_MS) return;
                const accountId = change.accountId;
                void refreshMine().then(() => {
                    if (!closed && mine.has(accountId)) wake(accountId);
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
