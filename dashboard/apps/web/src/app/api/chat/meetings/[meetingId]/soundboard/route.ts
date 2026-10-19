/**
 * What a call's soundboard picker offers this seat.
 *
 * A route rather than a server action, for the two reasons the seat heartbeat
 * is one: a tab in a call outlives the build that served it, and an action's id
 * does not, and server actions from one tab run one at a time - the picker
 * waited its turn behind everything else the call was asking, which is what made
 * it slow to open.
 *
 * Proved by a seat rather than by a session, like everything else about a call.
 */

import { z } from "zod";
import { readerWords } from "@/lib/i18n/reader-words";
import { resolveSeat } from "@/lib/chat/meeting-seat";
import { guardChat } from "@/lib/chat/chat-guard";
import { callSoundboard } from "@/lib/chat/soundboard-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const meetingIdSchema = z.string().uuid();

export async function GET(
    _request: Request,
    { params }: { params: Promise<{ meetingId: string }> }
): Promise<Response> {
    const parsed = meetingIdSchema.safeParse((await params).meetingId);
    const seat = parsed.success ? await resolveSeat(parsed.data) : null;
    if (!seat)
        return Response.json(
            { error: (await readerWords("chat"))("errors.notInCall") },
            { status: 410 }
        );
    const result = await guardChat(() => callSoundboard(seat));
    if (result.error) return Response.json({ error: result.error }, { status: 403 });
    return Response.json({ board: result.value }, { headers: { "cache-control": "no-store" } });
}
