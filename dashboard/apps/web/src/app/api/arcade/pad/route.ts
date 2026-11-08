/**
 * Phone pads (`lib/arcade/phone-pads.ts`). POST opens one for the game the
 * reader is playing; GET lists the reader's pads still waiting for a phone, so a
 * phone signed in to the same account connects with one tap.
 */

import { padError, padReader } from "@/lib/arcade/pad-route";
import { openPad, waitingPads } from "@/lib/arcade/phone-pads";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(): Promise<Response> {
    const user = await padReader();
    if (user instanceof Response) return user;
    const pad = openPad(user.id);
    if (!pad) return padError("tooManyRequests", 429);
    return Response.json(pad, { headers: { "Cache-Control": "no-store" } });
}

export async function GET(): Promise<Response> {
    const user = await padReader();
    if (user instanceof Response) return user;
    return Response.json(
        { pads: waitingPads(user.id) },
        { headers: { "Cache-Control": "no-store" } }
    );
}
