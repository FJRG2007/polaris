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
 * "Still here" also carries whether the person is muted or deafened, and whether
 * they are sharing a screen, which is how the people outside the call - never
 * connected to the media server - can see it. A beat without a body, from a tab
 * older than that, only keeps the seat.
 */

import { z } from "zod";
import { readerWords } from "@/lib/i18n/reader-words";
import { resolveSeat } from "@/lib/chat/meeting-seat";
import * as meetings from "@/lib/chat/meetings";
import { backgroundUser, sessionCan } from "@/lib/session";
import { callsUnavailable } from "@/lib/chat/call-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const meetingIdSchema = z.string().uuid();

// `streaming` is optional because a tab opened before it existed does not send
// it, and a beat from that tab must still keep the seat.
const voiceSchema = z
    .object({
        muted: z.boolean(),
        deafened: z.boolean(),
        streaming: z.boolean().optional(),
        rejoin: z.boolean().optional()
    })
    .strict();

type Params = { params: Promise<{ meetingId: string }> };

async function seatFor(params: Params["params"]) {
    const parsed = meetingIdSchema.safeParse((await params).meetingId);
    return parsed.success ? resolveSeat(parsed.data) : null;
}

/**
 * Take the seat again for a browser that is still in the call but whose row was
 * closed under it - a reload whose departure landed after the new page joined,
 * a sweep while the machine slept. Without it the tab went on carrying the call
 * on the media server while the roster said it had left, and nothing it did
 * could put it back. Accounts only, and the same row the browser's media
 * connection is under, never one a moderator or a host closed.
 */
async function reseat(meetingId: string): Promise<meetings.MeetingSeat | null> {
    const user = await backgroundUser();
    if (!user) return null;
    if (!(await sessionCan(user, "chat.use")) || !(await sessionCan(user, "chat.call")))
        return null;
    if (await callsUnavailable()) return null;
    try {
        return await meetings.retakeSeat({ id: user.id, name: user.name }, meetingId);
    } catch {
        return null;
    }
}

type Beat = meetings.VoiceState & { rejoin?: boolean };

/** What the beat says about the person's controls, or undefined when it says
 *  nothing. Anything that is not the expected shape is refused rather than
 *  half-read. */
async function voiceFrom(request: Request): Promise<Beat | undefined | null> {
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
    const beat = await voiceFrom(request);
    // i18n-ignore: a protocol answer the call client never shows
    if (beat === null) return Response.json({ error: "Malformed call state" }, { status: 400 });
    const { rejoin, ...voice } = beat ?? {};
    let seat = await seatFor(params);
    if (!seat && rejoin) {
        const parsed = meetingIdSchema.safeParse((await params).meetingId);
        if (parsed.success) seat = await reseat(parsed.data);
    }
    // Gone rather than not found: the seat was swept or left, and the browser
    // asking should stop rather than keep trying a path that exists.
    if (!seat)
        return Response.json(
            { error: (await readerWords("chat"))("errors.notInCall") },
            { status: 410 }
        );
    await meetings.keepSeat(seat, beat ? (voice as meetings.VoiceState) : undefined);
    return new Response(null, { status: 204 });
}

/** Gone. */
export async function DELETE(_request: Request, { params }: Params): Promise<Response> {
    const seat = await seatFor(params);
    if (seat) await meetings.leave(seat);
    return new Response(null, { status: 204 });
}
