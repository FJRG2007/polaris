/**
 * Where a client says whether anybody is at the computer its notification stream
 * runs on.
 *
 * Feeds the election of the one client that makes the account's sounds (see
 * `live-clients`): the desktop app wins it, but not while its computer sits
 * untouched, so a browser somebody is using elsewhere rings instead. The
 * connection is named by the id the stream itself handed out, looked up under
 * the session's own account, so a report can only ever move that account's
 * sounds between its own clients.
 *
 * Always answers 204, like the presence report beside it: there is nothing to
 * tell the client, and it is sent every few seconds.
 */

import { z } from "zod";
import { NextResponse } from "next/server";
import { backgroundUser } from "@/lib/session";
import { markLiveClientAway } from "@/lib/notifications/live-clients";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const attentionSchema = z.object({
    /** The connection, as the stream's frames name it. */
    connection: z.string().uuid(),
    /** True when nobody is at the computer. */
    away: z.boolean()
});

function accepted(): NextResponse {
    return new NextResponse(null, { status: 204 });
}

export async function POST(request: Request): Promise<NextResponse> {
    // The background read, like the stream's: a report sent while nobody is at
    // the computer must not keep their session alive.
    const session = await backgroundUser();
    if (!session) return accepted();

    let body: unknown;
    try {
        body = await request.json();
    } catch {
        return accepted();
    }

    const parsed = attentionSchema.safeParse(body);
    if (parsed.success) markLiveClientAway(session.id, parsed.data.connection, parsed.data.away);
    return accepted();
}
