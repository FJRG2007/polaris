/**
 * One live sample for one container: CPU, memory, and the bytes it has moved
 * over the network and to disk. This is what the container page refreshes on,
 * rather than the host listing - a page about one container should not cost a
 * stats read per container on the machine every few seconds.
 *
 * A container that is not running has nothing to sample, which is `stats: null`
 * rather than an error: the page still has details to show for it.
 */

import { containerStats } from "@/lib/container-service";
import { authorizeConnection, containerQuerySchema, parseQuery } from "../query";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
    const parsed = parseQuery(request.url, containerQuerySchema);
    if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });

    const caller = await authorizeConnection(parsed.data.c);
    if (!caller) return Response.json({ error: "Forbidden" }, { status: 403 });

    try {
        return Response.json({ stats: await containerStats(parsed.data.c, caller.userId, parsed.data.id) });
    } catch (caught) {
        return Response.json(
            { error: caught instanceof Error ? caught.message : "Could not read this container's usage" },
            { status: 502 }
        );
    }
}
