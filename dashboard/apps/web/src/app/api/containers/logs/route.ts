/**
 * A container's recent output. Tail-limited on the way in, so a container that
 * has been printing for a month cannot be asked for all of it. Local containers
 * are read through the host daemon's logs endpoint; every other transport reads
 * the Engine API directly.
 */

import { containerLogs } from "@/lib/container-service";
import { authorizeConnection, logsQuerySchema, parseQuery } from "../query";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
    const parsed = parseQuery(request.url, logsQuerySchema);
    if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });

    const caller = await authorizeConnection(parsed.data.c);
    if (!caller) return Response.json({ error: "Forbidden" }, { status: 403 });

    try {
        const text = await containerLogs(parsed.data.c, caller.userId, parsed.data.id, parsed.data.tail);
        return Response.json({ logs: text });
    } catch (caught) {
        return Response.json(
            { error: caught instanceof Error ? caught.message : "Could not read this container's logs" },
            { status: 502 }
        );
    }
}
