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
 * nothing of the call reaches them until they are admitted - and admission is
 * re-read rather than frozen at the moment the stream opened, since waiting to
 * be let in is precisely the state that is about to change.
 *
 * Anything addressed here before this stream existed is handed over first. The
 * browser that joins second is in the roster before it is listening, so the
 * first browser's offer is usually already waiting by the time it gets here.
 *
 * Node runtime, never cached.
 */

import { prisma } from "@polaris/db";
import { resolveSeat } from "@/lib/chat/meeting-seat";
import {
    subscribeMeetingEvents,
    subscribeSignals,
    takeHeldSignals
} from "@/lib/chat/meeting-signal";

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

    /** Settled by the request that proved the seat, and what everything below
     *  is about. Held on its own so the long-lived callbacks below do not each
     *  have to re-establish that the seat was not null. */
    const participantId = seat.participantId;

    const encoder = new TextEncoder();
    let closed = false;
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    let offSignals: (() => void) | null = null;
    let offEvents: (() => void) | null = null;
    // Whether the person at this end is in the room rather than at the door.
    // Mutable, because being let in is a thing that happens to an open stream,
    // and a stream that kept the answer it opened with would leave an admitted
    // guest waiting for signals that were being filtered out on their behalf.
    let admitted = seat.admission === "admitted";

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
                if (closed) return false;
                if (signal.meetingId !== meetingId) return false;
                if (signal.toId !== participantId) return false;
                // Waiting in the lobby means hearing nothing of the call itself.
                // Answering false rather than true holds it, so an offer sent
                // while somebody was at the door reaches them once they are let
                // in instead of being lost to the wait.
                if (!admitted) return false;
                send({ kind: "signal", fromId: signal.fromId, payload: signal.payload });
                return true;
            });

            offEvents = subscribeMeetingEvents((event) => {
                if (closed || event.meetingId !== meetingId) return;
                // The claim carries which browser made it, and nothing else
                // does: every browser in the call is told, and each compares it
                // with its own to find out whether it is still the one on the
                // line.
                send({ kind: event.kind, ...(event.deviceId ? { deviceId: event.deviceId } : {}) });
                // The roster moving is the only thing that can admit somebody,
                // and only a stream that is still waiting has to ask.
                if (event.kind === "roster" && !admitted) void recheckAdmission();
            });

            request.signal.addEventListener("abort", () => {
                stop();
                try {
                    controller.close();
                } catch {
                    // The client already went away.
                }
            });

            /**
             * Ask again whether this seat has been let in, and hand over what
             * was held while it was not.
             *
             * Read straight from the row rather than by resolving the seat
             * again: the seat was proved from the request, and this runs long
             * after that request's context has gone. The participant id was
             * settled then and is what is being asked about now.
             */
            async function recheckAdmission(): Promise<void> {
                const row = await prisma.meetingParticipant
                    .findFirst({
                        where: { id: participantId, meetingId, leftAt: null },
                        select: { admission: true }
                    })
                    .catch(() => null);
                if (closed || row?.admission !== "admitted") return;
                admitted = true;
                send({
                    kind: "seated",
                    participantId,
                    admission: "admitted"
                });
                drainHeld();
            }

            /** Whatever arrived for this participant before it was listening. */
            function drainHeld(): void {
                if (!admitted) return;
                for (const signal of takeHeldSignals(meetingId, participantId)) {
                    send({ kind: "signal", fromId: signal.fromId, payload: signal.payload });
                }
            }

            // Gets the response on the wire so EventSource fires `open`, and
            // tells the browser which participant it is - it needs its own id to
            // address the offers it is about to make.
            write(":ok\n\n");
            send({ kind: "seated", participantId, admission: seat.admission });
            // After the seat, never before: the browser has to know who it is
            // before it can make sense of an offer addressed to it.
            drainHeld();
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
