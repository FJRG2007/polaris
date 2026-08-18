/**
 * What a browser in a call listens to.
 *
 * The room, and only the room: who is in it, when it ended, and when this seat
 * was taken over by another device. The call itself is negotiated with the call
 * server over its own connection and none of it passes here.
 *
 * A stream is opened by proving a seat, which is either a session that reaches
 * the conversation or a guest cookie minted on the way in. Admission is re-read
 * rather than frozen at the moment the stream opened, since waiting to be let in
 * is precisely the state that is about to change - and the browser only asks the
 * call server for a ticket once this has told it that it is in.
 *
 * Node runtime, never cached.
 */

import { prisma } from "@polaris/db";
import { resolveSeat } from "@/lib/chat/meeting-seat";
import { subscribeMeetingEvents } from "@/lib/chat/meeting-events";

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
    let offEvents: (() => void) | null = null;
    // Whether the person at this end is in the room rather than at the door.
    // Mutable, because being let in is a thing that happens to an open stream,
    // and a stream that kept the answer it opened with would leave an admitted
    // guest sitting in a lobby their browser had already been let out of.
    let admitted = seat.admission === "admitted";

    function stop(): void {
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        heartbeat = null;
        offEvents?.();
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

            offEvents = subscribeMeetingEvents((event) => {
                if (closed || event.meetingId !== meetingId) return;
                // A claim is about one seat and concerns only the browsers
                // sitting in it. Sent to the whole room it did the opposite of
                // its job: everybody else read a device id they could not
                // recognise, concluded they had been replaced, and hung up - so
                // a second person joining ended the call for the first. The
                // browsers of this seat still compare the device id with their
                // own, which is what separates "another of my devices took it"
                // from "this is my own claim coming back".
                if (event.kind === "claimed" && event.participantId !== participantId) return;
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
             * Ask again whether this seat has been let in.
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
            }

            // Gets the response on the wire so EventSource fires `open`, and
            // tells the browser which participant it is - the identity it is
            // about to be given a ticket under.
            write(":ok\n\n");
            send({ kind: "seated", participantId, admission: seat.admission });
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
