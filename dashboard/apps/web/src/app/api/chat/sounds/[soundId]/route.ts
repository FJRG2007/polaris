/**
 * One soundboard sound's clip (/api/chat/sounds/<id>).
 *
 * Two ways in. With a call and the pass a play carried (`?m=<meeting>&t=<pass>`)
 * it is handed to whoever holds a seat in that call - a guest included, and
 * somebody who is not in the sound's space - because they are hearing it
 * played. Without them it is handed to whoever reaches the sound's space, which
 * is how the settings page and the picker preview one.
 *
 * Everybody else is told there is no such sound, the same answer as a sound
 * that was deleted.
 */

import { backgroundUser } from "@/lib/session";
import { resolveSeat } from "@/lib/chat/meeting-seat";
import { readSound } from "@/lib/chat/soundboard-service";
import { readSoundTicket } from "@/lib/chat/soundboard-ticket";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function missing(): Response {
    return new Response("Not found", {
        status: 404,
        headers: { "Cache-Control": "private, no-store" }
    });
}

export async function GET(
    request: Request,
    { params }: { params: Promise<{ soundId: string }> }
): Promise<Response> {
    const { soundId: raw } = await params;
    if (!UUID.test(raw)) return missing();
    const soundId = raw.toLowerCase();

    const query = new URL(request.url).searchParams;
    const meetingId = query.get("m")?.toLowerCase() ?? "";
    const ticket = query.get("t") ?? "";
    const played =
        UUID.test(meetingId) && ticket
            ? {
                  ticketValid: readSoundTicket(ticket, soundId, meetingId),
                  seat: await resolveSeat(meetingId)
              }
            : null;
    const user = played?.ticketValid && played.seat ? null : await backgroundUser();
    if (!played?.seat && !user) return missing();

    const sound = await readSound(user ? { id: user.id } : null, soundId, played);
    if (!sound) return missing();

    return new Response(sound.bytes as BodyInit, {
        headers: {
            "Content-Type": sound.mime,
            "Content-Length": String(sound.bytes.length),
            // A sound's clip never changes under its id - replacing one is
            // deleting it and uploading another - so a browser keeps it.
            "Cache-Control": "private, max-age=86400, immutable",
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'; sandbox",
            "Content-Disposition": "inline"
        }
    });
}
