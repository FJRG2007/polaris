/**
 * Phone pads (`lib/arcade/phone-pads.ts`). POST opens one for the game the
 * reader is playing (`{ game }`, the game's id, optional; the device is read from
 * the request), so the owner's phone can name it; GET lists the reader's pads still waiting for a phone, so a
 * phone signed in to the same account connects with one tap.
 */

import { z } from "zod";
import { describeDevice } from "@polaris/core";
import { padError, padReader } from "@/lib/arcade/pad-route";
import { openPad, waitingPads } from "@/lib/arcade/phone-pads";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const openSchema = z
    .object({
        game: z
            .string()
            .trim()
            .regex(/^[a-z0-9-]{1,48}$/)
            .optional()
    })
    .strict();

export async function POST(request: Request): Promise<Response> {
    const user = await padReader();
    if (user instanceof Response) return user;
    // An empty body is the older game page, which named nothing: still a pad
    const raw = await request.text().catch(() => "");
    let body: unknown = {};
    try {
        body = raw.trim() ? JSON.parse(raw) : {};
    } catch {
        return padError("invalidRequest", 400);
    }
    const parsed = openSchema.safeParse(body);
    if (!parsed.success) return padError("invalidRequest", 400);
    const device = describeDevice(
        request.headers.get("user-agent"),
        request.headers.get("sec-ch-ua"),
        request.headers.get("sec-ch-ua-platform")
    ).slice(0, 80);
    const pad = openPad(user.id, { game: parsed.data.game, device });
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
