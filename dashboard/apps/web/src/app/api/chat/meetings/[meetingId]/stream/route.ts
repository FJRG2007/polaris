/**
 * What a browser in a call listens to.
 *
 * Two things come down it: signals addressed to this participant, and the fact
 * that the roster moved. Signals are filtered by participant id here, so one
 * peer's offer never reaches a third browser - and since the payload is opaque
 * to this server, that filter is the only thing standing between them.
 *
 * A stream is opened by proving a seat, which is either a session that reaches
 * the conversation or a guest cookie minted on the way in. Somebody still in the
 * lobby gets the roster and no signals, which is exactly what waiting is:
 * nothing of the call reaches them until they are admitted.
 *
 * Node runtime, never cached.
 */

import { resolveSeat } from "@/lib/chat/meeting-seat";
import { subscribeMeetingEvents, subscribeSignals } from "@/lib/chat/meeting-signal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Idle keep-alive, under every proxy's patience. */
const HEARTBEAT_MS = 20_000;

export async function GET(
    request: Request,
    { params }: { params: Promise<{ meetingId: string }> }
): Promise<Response> {
    const { meetingId } = await params;
    const seat = await resolveSeat(meetingId);
    // A non-200 makes EventSource give up rather than reconnect forever against
    // a call it is not in.
    if (!seat) return Response.json({ error: "Not in that call" }, { status: 403 });

    const encoder = new TextEncoder();
    let closed = false;
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    let offSignals: (() => void) | null = null;
    let offEvents: (() => void) | null = null;

    function stop(): void {
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        heartbeat = null;
        offSignals?.();
        offEvents?.();
        offSignals = null;
        offEvents = null;
    }

    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
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

            offSignals = subscribeSignals((signal) => {
                if (closed) return;
                if (signal.meetingId !== meetingId) return;
                if (signal.toId !== seat.participantId) return;
                // Waiting in the lobby means hearing nothing of the call itself.
                if (seat.admission !== "admitted") return;
                send({ kind: "signal", fromId: signal.fromId, payload: signal.payload });
            });

            offEvents = subscribeMeetingEvents((event) => {
                if (closed || event.meetingId !== meetingId) return;
                send({ kind: event.kind });
            });

            request.signal.addEventListener("abort", () => {
                stop();
                try {
                    controller.close();
                } catch {
                    // The client already went away.
                }
            });

            // Gets the response on the wire so EventSource fires `open`, and
            // tells the browser which participant it is - it needs its own id to
            // address the offers it is about to make.
            write(":ok\n\n");
            send({ kind: "seated", participantId: seat.participantId, admission: seat.admission });
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
            "x-accel-buffering": "no"
        }
    });
}
