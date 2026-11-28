/**
 * The live channel of every Hospitality screen: a tablet, a handheld or the
 * kitchen display holds it open and is told when its venue changed, then reads
 * again. The frame is `{ seq, topic }` and nothing else, so it never carries a
 * row somebody may not read. Served by this Polaris on the venue's own network:
 * no internet in the path.
 */

import { host } from "@polaris/app-host";
import { subscribeHospitalityChanges, type HospitalityChange } from "../../../../lib/live";

/** A burst of changes (a whole order sent at once) is one wake-up. */
const COALESCE_MS = 250;
/** Keeps proxies from dropping a quiet stream. */
const HEARTBEAT_MS = 25_000;

export async function GET(request: Request): Promise<Response> {
    let userId: string;
    try {
        userId = (await host.session.requirePermission("hospitality.use")).id;
    } catch {
        return new Response(null, { status: 401 });
    }
    const venueId = new URL(request.url).searchParams.get("venue");
    const encoder = new TextEncoder();
    let unsubscribe: (() => void) | null = null;
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    let pending: ReturnType<typeof setTimeout> | null = null;
    let topics = new Set<string>();
    let sequence = 0;
    let closed = false;

    const stop = () => {
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        if (pending) clearTimeout(pending);
        unsubscribe?.();
        unsubscribe = null;
    };

    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            const write = (frame: string) => {
                if (closed) return;
                try {
                    controller.enqueue(encoder.encode(frame));
                } catch {
                    stop();
                }
            };
            const wake = (change: HospitalityChange) => {
                // The device that wrote already shows its own change.
                if (closed || change.actorId === userId) return;
                if (change.venueId && venueId && change.venueId !== venueId) return;
                topics.add(change.topic);
                if (pending) return;
                pending = setTimeout(() => {
                    pending = null;
                    sequence += 1;
                    write(`data: ${JSON.stringify({ seq: sequence, topics: [...topics] })}\n\n`);
                    topics = new Set();
                }, COALESCE_MS);
            };
            unsubscribe = subscribeHospitalityChanges(wake);
            heartbeat = setInterval(() => write(": keep-alive\n\n"), HEARTBEAT_MS);
            write(": open\n\n");
            request.signal.addEventListener("abort", () => {
                stop();
                try {
                    controller.close();
                } catch {
                    // Already closed.
                }
            });
        },
        cancel: stop
    });

    return new Response(stream, {
        headers: {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no"
        }
    });
}
