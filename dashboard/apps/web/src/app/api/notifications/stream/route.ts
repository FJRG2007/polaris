/**
 * Live notification feed. The connection stays open and the current list is
 * pushed whenever it changes, so the bell and the notifications page follow
 * along without a reload. Change detection is a server-side poll rather than an
 * in-process event bus because notifications are also written by background work
 * (scans, alarms, the network check); polling covers every producer with one
 * path. Node runtime for Prisma, and always scoped to the session user.
 *
 * Each frame also says whether the connection reading it is the one that should
 * make a sound. The clients cannot work that out between themselves: the tabs of
 * a browser can, but the desktop app runs in a storage partition of its own, so
 * its claim and a tab's are written where neither can read the other - and a
 * message chimed once in the app and again in the browser. See `live-clients`.
 */

import { z } from "zod";
import { randomUUID } from "node:crypto";
import { resolveSession } from "@/lib/session";
import { listNotifications, NOTIFICATION_FEED_LIMIT } from "@/lib/notification-service";
import {
    closeLiveClient,
    liveClientChimes,
    openLiveClient,
    touchLiveClient
} from "@/lib/notifications/live-clients";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** How often the feed is re-read. Fast enough to read as live, cheap enough to hold open. */
const POLL_MS = 5000;

/** What kind of Polaris is asking. A value nobody recognises is not refused - the
 *  kind only decides which client makes a sound, and getting it wrong must never
 *  cost somebody their feed - it simply takes no part in the election. */
const clientSchema = z.enum(["desktop", "browser"]);

/** Whether that client would make the sound if it were the one elected to. Absent
 *  is read as yes, which is what the switch defaults to and the safe direction:
 *  the cost of being wrong is a chime somebody turned off, not silence. */
const soundSchema = z.enum(["on", "off"]).catch("on");

export async function GET(request: Request): Promise<Response> {
    const session = await resolveSession();
    // A non-200 makes EventSource give up instead of reconnecting every few
    // seconds against a session that is gone.
    if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

    const userId = session.id;
    // Nobody, where it was not said. Only a connection that declared itself is
    // listening for the answer below, so one that did not - something that is not
    // this Polaris, a tab still running an older build - must not be able to hold
    // an election the client waiting on it would lose. It is still served, and it
    // is still told to chime.
    const asked = new URL(request.url).searchParams;
    const declared = clientSchema.safeParse(asked.get("client"));
    const kind = declared.success ? declared.data : null;
    const rings = soundSchema.parse(asked.get("sound")) === "on";
    // Names this connection and nothing else. Minted here rather than taken from
    // the client, so nothing can claim to be somebody else's connection.
    const connection = randomUUID();
    const encoder = new TextEncoder();
    let timer: ReturnType<typeof setInterval> | null = null;
    let closed = false;
    let previous = "";

    function stop(): void {
        closed = true;
        if (timer) clearInterval(timer);
        timer = null;
        closeLiveClient(userId, connection);
    }

    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            if (kind) openLiveClient(userId, connection, kind, rings);

            async function tick(): Promise<void> {
                if (closed) return;
                // Said on every tick, so a connection that is open is never swept
                // out from under itself for being quiet.
                if (kind) touchLiveClient(userId, connection, kind, rings);
                let payload: string;
                try {
                    payload = JSON.stringify({
                        items: await listNotifications(userId, NOTIFICATION_FEED_LIMIT),
                        // Whether this connection is the one to make the sound. It
                        // rides the frame rather than being asked for separately
                        // because it can change while a connection is open - the
                        // desktop app opening takes it off a browser tab - and the
                        // frame is the only thing the client is already listening
                        // to.
                        chime: kind === null || liveClientChimes(userId, connection)
                    });
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
