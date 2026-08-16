/**
 * Where a page's worth of people are.
 *
 * A route rather than a server action because it is asked constantly, by a store
 * that batches whatever faces are on screen and comes back once - and because
 * every screen in Polaris draws faces, which is a lot of surfaces to thread a
 * server action through.
 *
 * Ids arrive from a browser, so nothing is trusted about them: they are looked
 * up, they are answered through the privacy rule, and there are at most a
 * page-full. Asking about an id that does not exist gets nothing back rather
 * than an error - a face that has gone is not an exception.
 */

import { z } from "zod";
import { requireUser } from "@/lib/session";
import { presenceFor } from "@/lib/presence-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** More than any one screen draws at once, and a ceiling on what one request can
 *  ask this to look up. */
const MOST = 200;

const askSchema = z.object({ ids: z.array(z.string().uuid()).max(MOST) });

export async function POST(request: Request): Promise<Response> {
    const viewer = await requireUser();

    let body: unknown;
    try {
        body = await request.json();
    } catch {
        return Response.json({ error: "That could not be read" }, { status: 400 });
    }
    const asked = askSchema.safeParse(body);
    if (!asked.success) return Response.json({ error: "That could not be read" }, { status: 400 });

    const found = await presenceFor(
        { id: viewer.id, isAdmin: Boolean(viewer.isAdmin) },
        asked.data.ids
    );
    return Response.json(
        { people: Object.fromEntries(found) },
        // Never kept: the whole value of this is that it is true now.
        { headers: { "Cache-Control": "private, no-store" } }
    );
}
