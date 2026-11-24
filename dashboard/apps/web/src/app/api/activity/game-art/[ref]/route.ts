/**
 * A game's picture, as this server keeps it (`lib/presence-activity/game-art`).
 *
 * Served from here rather than linked from the store, so the store never sees
 * who is looking at whom. Signed-in readers only, and only for a store id this
 * server asks or a game's `name:` to look up: anything else is a 404, which a
 * card draws as the game glyph.
 */

import { backgroundUser } from "@/lib/session";
import { rateLimit } from "@/lib/rate-limit-service";
import { pictureFor } from "@/lib/presence-activity/game-art";
import { nameOfRef } from "@/lib/presence-activity/game-art-lookup";
import { resolvable } from "@/lib/presence-activity/game-art-sources";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Pictures one account may ask for in a window: a member list of a few hundred people. */
const ART_LIMIT = 600;
const ART_WINDOW_MS = 60_000;

const NONE = { status: 404, headers: { "Cache-Control": "private, max-age=300" } } as const;

/** The id as written, whether or not the router already decoded it. */
function decoded(raw: string): string {
    try {
        return decodeURIComponent(raw);
    } catch {
        return raw;
    }
}

export async function GET(_request: Request, context: { params: Promise<{ ref: string }> }): Promise<Response> {
    const user = await backgroundUser();
    if (!user) return new Response(null, { status: 401 });
    const ref = decoded((await context.params).ref);
    if (!resolvable(ref) && nameOfRef(ref) === null) return new Response(null, NONE);
    const throttle = await rateLimit(`game-art:${user.id}`, ART_LIMIT, ART_WINDOW_MS);
    if (!throttle.ok) return new Response(null, { status: 429, headers: { "Retry-After": String(Math.ceil(throttle.retryAfterMs / 1000)) } });
    const image = await pictureFor(ref).catch(() => null);
    if (!image) return new Response(null, NONE);
    return new Response(Buffer.from(image), {
        headers: {
            "Content-Type": "image/webp",
            "Content-Length": String(image.byteLength),
            "Cache-Control": "private, max-age=86400",
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'"
        }
    });
}
