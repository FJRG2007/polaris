/**
 * Who is playing, pushed as it changes.
 *
 * The list of servers and both game panels used to poll for this, each on its own
 * clock, which made "is anybody on" both late and expensive: a poll's worth of
 * delay before a screen noticed somebody had joined, multiplied by every screen
 * open. Here the reading is taken once for everybody listening and sent the moment
 * it changes - and nothing is read at all while nobody is connected.
 *
 * Node runtime because the reading reaches containers, and scoped to the session:
 * a viewer is told about their own servers and the ones they were invited to, and
 * the connection keeps serving that account for its whole life.
 */

import { z } from "zod";
import { requirePermissionAny } from "@/lib/session";
import { reachableInstallIds } from "@/lib/apps/install-access";
import { subscribeGamePresence } from "@/lib/apps/games-presence";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** How often the connection says it is still there when nothing has changed. A
 *  quiet feed is normal here - most minutes nobody joins or leaves - and a proxy
 *  in the middle will close an idle one. */
const BEAT_MS = 15_000;

export async function GET(request: Request): Promise<Response> {
    // A non-200 makes EventSource give up rather than reconnect every few seconds
    // against a session that is gone.
    const user = await requirePermissionAny("games.read").catch(() => null);
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const granted = await reachableInstallIds(user, "games.read").catch(() => []);
    // Which servers this connection is about. A server's own page names itself, so
    // the watcher behind it reads that one rather than every server the account
    // has - each of which is a command inside a container. Nothing is trusted from
    // it: the reading is built from what this session may see either way, and an id
    // that is not theirs simply matches nothing.
    const asked = readServerIds(new URL(request.url).searchParams.get("server"));

    const encoder = new TextEncoder();
    let unsubscribe: (() => void) | null = null;
    let beat: ReturnType<typeof setInterval> | null = null;
    let closed = false;

    function stop(): void {
        closed = true;
        unsubscribe?.();
        unsubscribe = null;
        if (beat) clearInterval(beat);
        beat = null;
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

            unsubscribe = subscribeGamePresence(
                user.id,
                granted,
                (reading) => send(`data: ${JSON.stringify(reading)}\n\n`),
                asked
            );
            beat = setInterval(() => send(":\n\n"), BEAT_MS);
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

/** The servers a connection named, or undefined for "all of mine". Ids only, so a
 *  query string cannot widen what is read into anything but a list of installs. */
function readServerIds(raw: string | null): string[] | undefined {
    if (!raw) return undefined;
    const parsed = z.array(z.string().uuid()).max(50).safeParse(raw.split(",").map((id) => id.trim()));
    return parsed.success && parsed.data.length > 0 ? parsed.data : undefined;
}
