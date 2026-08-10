/**
 * Where a tab says what it is showing.
 *
 * Feeds the presence registry the dispatcher consults before deciding whether an
 * alert arrives already read - see lib/notifications/presence. The report is a
 * claim by a browser and is scoped to the session that made it, so the only
 * account a tab can ever affect is its own, and the only effect it can have is
 * to keep the bell quiet about a page it says it is displaying.
 *
 * Always answers 204. There is nothing to tell a tab about its own report, and a
 * body would only be something to parse on a path that runs every few seconds.
 */

import { z } from "zod";
import { NextResponse } from "next/server";
import { resolveSession } from "@/lib/session";
import { dropPresence, recordPresence } from "@/lib/notifications/presence";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const presenceSchema = z.object({
    /** Identifies the tab, not the person. Minted by the tab and meaningful only
     *  against its own account. */
    viewerId: z.string().uuid(),
    path: z.string().min(1).max(512).startsWith("/"),
    /** False when the tab went to the background or is closing. */
    viewing: z.boolean()
});

function accepted(): NextResponse {
    return new NextResponse(null, { status: 204 });
}

export async function POST(request: Request): Promise<NextResponse> {
    const session = await resolveSession();
    if (!session) return accepted();

    let body: unknown;
    try {
        body = await request.json();
    } catch {
        return accepted();
    }

    const parsed = presenceSchema.safeParse(body);
    if (!parsed.success) return accepted();

    const { viewerId, path, viewing } = parsed.data;
    if (viewing) recordPresence(session.id, viewerId, path);
    else dropPresence(session.id, viewerId);
    return accepted();
}
