/**
 * One live sample for one container: CPU, memory, and the bytes it has moved
 * over the network and to disk. This is what the container page refreshes on,
 * rather than the host listing - a page about one container should not cost a
 * stats read per container on the machine every few seconds.
 *
 * The last sample is answered straight away, with its age, and a fresh one is
 * taken behind the response: the daemon holds a stats request open for about a
 * second, and a page that has just been opened from the listing already has a
 * number worth showing while that second passes. Only a container nothing has
 * ever sampled is waited for, because for that one there is nothing else to say.
 *
 * A container that is not running has nothing to sample, which is `stats: null`
 * rather than an error: the page still has details to show for it.
 */

import { containerStats } from "@/lib/container-service";
import { authorizeConnection, containerQuerySchema, parseQuery } from "../query";
import { cachedSample, refreshSamples, rememberSample, STATS_TTL_MS } from "@/lib/container-stats-cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
    const parsed = parseQuery(request.url, containerQuerySchema);
    if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });

    const caller = await authorizeConnection(parsed.data.c);
    if (!caller) return Response.json({ error: "Forbidden" }, { status: 403 });

    const cached = cachedSample(parsed.data.c, parsed.data.id);
    if (cached) {
        if (Date.now() - cached.at > STATS_TTL_MS) {
            refreshSamples(parsed.data.c, caller.userId, [{ id: parsed.data.id }]);
        }
        return Response.json({ stats: cached.stats, at: cached.at });
    }

    try {
        const stats = await containerStats(parsed.data.c, caller.userId, parsed.data.id);
        // Under the ref it was asked for, so the page's next tick reads it back
        // without paying for the sample again.
        if (stats) rememberSample(parsed.data.c, [parsed.data.id], stats);
        return Response.json({ stats, at: stats ? Date.now() : null });
    } catch (caught) {
        return Response.json(
            { error: caught instanceof Error ? caught.message : "Could not read this container's usage" },
            { status: 502 }
        );
    }
}
