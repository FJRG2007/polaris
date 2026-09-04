/**
 * Whose photo this reader may open, for a page's worth of faces.
 *
 * A face is drawn from an id and nothing else, everywhere in Polaris, so the one
 * thing a face cannot do is carry somebody's privacy setting with it. This is
 * asked the way presence is asked - batched by a store that collects whatever is
 * on screen and comes back once - because the alternative is threading an answer
 * through every list, table and menu that draws a person.
 *
 * It decides an affordance, not access to bytes: the photo behind a face and the
 * photo in the viewer are the same address, which is what the setting's own note
 * says. Answering here is what keeps the decision on the server rather than in a
 * browser that could simply not ask.
 */

import { z } from "zod";
import { apiUser } from "@/lib/api-session";

import { allowedBy } from "@/lib/privacy-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** More than any one screen draws at once, and a ceiling on what one request can
 *  ask this to look up. */
const MOST = 200;

const askSchema = z.object({ ids: z.array(z.string().uuid()).max(MOST) });

export async function POST(request: Request): Promise<Response> {
    const viewer = await apiUser();
    if (viewer instanceof Response) return viewer;

    let body: unknown;
    try {
        body = await request.json();
    } catch {
        return Response.json({ error: "That could not be read" }, { status: 400 });
    }
    const asked = askSchema.safeParse(body);
    if (!asked.success) return Response.json({ error: "That could not be read" }, { status: 400 });

    const allowed = await allowedBy(
        { id: viewer.id, isAdmin: Boolean(viewer.isAdmin) },
        "photoFullSize",
        asked.data.ids
    );
    return Response.json(
        { allowed: [...allowed] },
        // A setting somebody changed on another tab should reach this one when
        // the store next asks, rather than after a cache has let go of it.
        { headers: { "Cache-Control": "private, no-store" } }
    );
}
