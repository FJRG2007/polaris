/**
 * One container's consumption history over a preset (?range=1h|6h|1d|7d|30d) or
 * a custom window (?from=&to= in epoch ms), from the samples the collector files
 * every minute for each running container on the machines it measures.
 *
 * Read by host and name, the same `c` and `id` as the rest of the container
 * routes: the name is what survives a redeploy, so the history does too.
 */

import { resolveRange } from "@/lib/metrics-shared";
import { readerWords } from "@/lib/i18n/reader-words";
import { getContainerMetricSeries } from "@/lib/metrics-history-service";
import { containerMetricSubject } from "@/lib/container-metric-subject";
import { authorizeConnection, containerQuerySchema, parseQuery } from "../query";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
    const parsed = parseQuery(request.url, containerQuerySchema);
    if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });

    const caller = await authorizeConnection(parsed.data.c);
    if (!caller)
        return Response.json(
            { error: (await readerWords("api"))("errors.forbidden") },
            { status: 403 }
        );

    const url = new URL(request.url);
    const { from, to } = resolveRange(
        url.searchParams.get("range"),
        url.searchParams.get("from"),
        url.searchParams.get("to")
    );
    const points = await getContainerMetricSeries({
        subjectId: containerMetricSubject(parsed.data.c, parsed.data.id),
        from,
        to
    });
    return Response.json({ points });
}
