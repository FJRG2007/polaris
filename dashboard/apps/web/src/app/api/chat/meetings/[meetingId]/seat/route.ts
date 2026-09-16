/**
 * Holding a seat in a call: "still here" and "gone".
 *
 * A route rather than a server action, and that is the whole reason it exists. A
 * server action is addressed by an id the build that served the page minted, so
 * a Polaris update under an open call made every heartbeat a 404: the tabs gave
 * up, the new server swept everybody off the roster half a minute later, and the
 * call ended for all of them while the media server was still carrying it. This
 * path is the same in every build, so a call outlives the update.
 *
 * Proved by a seat rather than by a session, like everything else about a call.
 *
 * "Still here" also carries whether the person is muted or deafened, which is
 * how the people outside the call - never connected to the media server - can
 * see it. A beat without a body, from a tab older than that, only keeps the seat.
 */

import { z } from "zod";
import { resolveSeat } from "@/lib/chat/meeting-seat";
import * as meetings from "@/lib/chat/meetings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const meetingIdSchema = z.string().uuid();

const voiceSchema = z.object({ muted: z.boolean(), deafened: z.boolean() }).strict();

type Params = { params: Promise<{ meetingId: string }> };

async function seatFor(params: Params["params"]) {
    const parsed = meetingIdSchema.safeParse((await params).meetingId);
    return parsed.success ? resolveSeat(parsed.data) : null;
}

/** What the beat says about the person's controls, or undefined when it says
 *  nothing. Anything that is not the expected shape is refused rather than
 *  half-read. */
async function voiceFrom(request: Request): Promise<meetings.VoiceState | undefined | null> {
    const text = await request.text().catch(() => "");
    if (text.trim() === "") return undefined;
    let body: unknown;
    try {
        body = JSON.parse(text);
    } catch {
        return null;
    }
    const parsed = voiceSchema.safeParse(body);
    return parsed.success ? parsed.data : null;
}

/** Still here. */
export async function POST(request: Request, { params }: Params): Promise<Response> {
    const seat = await seatFor(params);
    // Gone rather than not found: the seat was swept or left, and the browser
    // asking should stop rather than keep trying a path that exists.
    if (!seat) return Response.json({ error: "You are not in that call" }, { status: 410 });
    const voice = await voiceFrom(request);
    if (voice === null) return Response.json({ error: "Malformed call state" }, { status: 400 });
    await meetings.keepSeat(seat, voice);
    return new Response(null, { status: 204 });
}

/** Gone. */
export async function DELETE(_request: Request, { params }: Params): Promise<Response> {
    const seat = await seatFor(params);
    if (seat) await meetings.leave(seat);
    return new Response(null, { status: 204 });
}
