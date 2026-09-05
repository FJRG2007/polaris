/**
 * The appearance of a page's worth of people.
 *
 * Asked by the store the faces share, exactly as presence is: a screen mounts
 * thirty avatars, the ids are collected for a tick, and one request answers all
 * of them. Ids arrive from a browser, so at most a page-full, and an id that is
 * nobody gets a plain style back rather than an error - a face that has gone is
 * not an exception.
 *
 * Unlike presence, what comes back does not go stale: a decoration is a decision
 * somebody made, not where they are, so this is allowed to sit in the browser's
 * cache for a few minutes and the store keeps it for the session.
 */

import { z } from "zod";
import { apiUser } from "@/lib/api-session";
import { stylesFor } from "@/lib/profile-style-service";

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

    const found = await stylesFor(asked.data.ids);
    return Response.json(
        { people: Object.fromEntries(found) },
        { headers: { "Cache-Control": "private, max-age=120" } }
    );
}
