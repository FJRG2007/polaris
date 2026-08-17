/**
 * One browser saying something to another one, on the way to talking directly.
 *
 * The payload is opaque here - an SDP offer, an answer, or an ICE candidate -
 * and this route's whole job is to check that the sender and the recipient are
 * both admitted to the same call before it relays it. That check is what stops
 * this from being a message channel between any two accounts on the instance.
 *
 * The size limit is not a formality: without one, a browser could keep this
 * server's memory busy relaying whatever it liked between two tabs it controls.
 */

import { z } from "zod";
import { prisma } from "@polaris/db";
import { resolveSeat } from "@/lib/chat/meeting-seat";
import { MAX_SIGNAL_BYTES, publishSignal } from "@/lib/chat/meeting-signal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
    toId: z.string().uuid(),
    payload: z.string().min(1).max(MAX_SIGNAL_BYTES)
});

/** The same, minus the size, so the two refusals can be told apart: a payload
 *  that is merely too big is a different thing from a body this cannot read, and
 *  answering both with 400 is what made a dead call impossible to diagnose. */
const shapeSchema = z.object({ toId: z.string().uuid(), payload: z.string().min(1) });

export async function POST(
    request: Request,
    { params }: { params: Promise<{ meetingId: string }> }
): Promise<Response> {
    const { meetingId } = await params;
    const seat = await resolveSeat(meetingId);
    if (!seat) return Response.json({ error: "Not in that call" }, { status: 403 });
    if (seat.admission !== "admitted") {
        return Response.json({ error: "Still waiting to be let in" }, { status: 403 });
    }

    let raw: unknown;
    try {
        raw = await request.json();
    } catch {
        return Response.json({ error: "That could not be read" }, { status: 400 });
    }
    const parsed = bodySchema.safeParse(raw);
    if (!parsed.success) {
        // Said out loud, both to the caller and to the log. A signal that is
        // refused is a call that will never connect, and the browser has no way
        // of knowing which of the two happened.
        const shape = shapeSchema.safeParse(raw);
        if (shape.success) {
            console.warn(
                `chat: a call signal of ${shape.data.payload.length} characters was refused in meeting ${meetingId} (the limit is ${MAX_SIGNAL_BYTES})`
            );
            return Response.json(
                { error: "That is too large to relay" },
                { status: 413 }
            );
        }
        return Response.json({ error: "That could not be read" }, { status: 400 });
    }

    // The recipient has to be in this same call and admitted to it. Resolved
    // here rather than trusted from the sender, which is the point of the route.
    const target = await prisma.meetingParticipant.findFirst({
        where: {
            id: parsed.data.toId,
            meetingId,
            leftAt: null,
            admission: "admitted"
        },
        select: { id: true }
    });
    if (!target) return Response.json({ error: "They are not in that call" }, { status: 404 });

    publishSignal({
        meetingId,
        fromId: seat.participantId,
        toId: target.id,
        payload: parsed.data.payload
    });
    return Response.json({ ok: true });
}
