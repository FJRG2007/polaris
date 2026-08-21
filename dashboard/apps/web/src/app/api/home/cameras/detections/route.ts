/**
 * What the cameras are looking at, for the screens that are looking at them.
 *
 * A route rather than a server action because it is polled: an action is a POST
 * through the whole render pipeline, and this is a handful of numbers asked for
 * twice a second by whoever has Places open.
 *
 * Several cameras at once, and that is the reason it is not under `[id]`. A wall
 * is a dozen tiles, and a request per tile would be a dozen session lookups
 * twice a second to answer with a dozen empty lists - the cost would scale with
 * how many cameras a house has, which is exactly the wrong thing for it to scale
 * with. One ask, one answer, whatever is on screen.
 *
 * Cheap past the session check: the positions are in memory, published by the
 * worker moments ago, so there is no query at all.
 *
 * The ids are not looked up. They do not need to be: the only thing that can
 * ever be published under one is a camera of this house, because the route the
 * worker posts to checks that before it stores anything. So an id that is not a
 * camera has nothing to draw, which is the same answer as a camera with nothing
 * in front of it.
 */

import type { LiveBox } from "@polaris/core";
import { homeInstall } from "@/lib/home/access";
import { liveBoxes } from "@/lib/home/live-boxes";
import { requireUser, sessionCan } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** How many cameras one ask may cover. A wall is a dozen; this is the point past
 *  which somebody is not reading a screen. */
const MAX_CAMERAS = 64;

export async function GET(request: Request): Promise<Response> {
    const user = await requireUser();
    if (!(await sessionCan(user, "home.read"))) return new Response("Forbidden", { status: 403 });
    const install = await homeInstall();
    if (!install) return new Response("Not found", { status: 404 });

    const asked = (new URL(request.url).searchParams.get("ids") ?? "")
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean)
        .slice(0, MAX_CAMERAS);

    const boxes: Record<string, readonly LiveBox[]> = {};
    for (const id of asked) {
        const found = liveBoxes(id);
        // Only what is there. A camera with nothing in front of it is most of
        // them most of the time, and an empty array each is the bulk of the
        // answer for no reason.
        if (found.length > 0) boxes[id] = found;
    }

    return Response.json(
        { boxes },
        // Never from a cache. A remembered answer here is a rectangle that stays
        // where somebody used to be, which is the one thing this must not draw.
        { headers: { "cache-control": "no-store" } }
    );
}
