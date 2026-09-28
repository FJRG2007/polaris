/**
 * Listening along with somebody's Spotify: who you are following, start, stop.
 *
 * A route rather than a server action because the button that uses it is drawn
 * on every card that shows a track - in Chat and on a profile page - and it
 * keeps one small answer ("who am I following") that every card on a screen
 * shares.
 *
 * Everything that decides whether it is allowed happens in `startListenAlong`,
 * through the presence rule: the host id is only a name for whose card was
 * pressed, and a card the listener may not see refuses exactly like one with
 * nothing on it. Rate limited per account, because every start is a command to
 * somebody's Spotify.
 */

import { z } from "zod";
import { apiUser } from "@/lib/api-session";
import { rateLimit } from "@/lib/rate-limit-service";
import {
    listenAlongOf,
    ListenAlongError,
    startListenAlong,
    stopListenAlong
} from "@/lib/presence-activity/listen-along";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const START_LIMIT = 10;
const START_WINDOW_MS = 60_000;

const startSchema = z.object({ hostId: z.string().uuid() });

const NO_STORE = { "Cache-Control": "private, no-store" };

export async function GET(): Promise<Response> {
    const user = await apiUser();
    if (user instanceof Response) return user;
    return Response.json({ hostId: await listenAlongOf(user.id) }, { headers: NO_STORE });
}

export async function POST(request: Request): Promise<Response> {
    const user = await apiUser();
    if (user instanceof Response) return user;

    let body: unknown;
    try {
        body = await request.json();
    } catch {
        return Response.json({ error: "That could not be read" }, { status: 400 });
    }
    const asked = startSchema.safeParse(body);
    if (!asked.success) return Response.json({ error: "That could not be read" }, { status: 400 });

    const throttle = await rateLimit(`listen-along:${user.id}`, START_LIMIT, START_WINDOW_MS);
    if (!throttle.ok) {
        return Response.json(
            { error: "That is a lot of songs at once. Try again in a minute." },
            {
                status: 429,
                headers: { "Retry-After": String(Math.ceil(throttle.retryAfterMs / 1000)) }
            }
        );
    }

    try {
        await startListenAlong({ id: user.id, isAdmin: Boolean(user.isAdmin) }, asked.data.hostId);
    } catch (caught) {
        if (caught instanceof ListenAlongError) {
            return Response.json({ error: caught.message, kind: caught.kind }, { status: 409 });
        }
        console.error("polaris: listen along could not start:", caught);
        return Response.json(
            { error: "Listening along could not start. Try again in a moment." },
            { status: 500 }
        );
    }
    return Response.json({ hostId: asked.data.hostId }, { headers: NO_STORE });
}

export async function DELETE(): Promise<Response> {
    const user = await apiUser();
    if (user instanceof Response) return user;
    await stopListenAlong(user.id);
    return Response.json({ hostId: null }, { headers: NO_STORE });
}
