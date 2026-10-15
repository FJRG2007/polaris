import { apiPermission } from "@/lib/api-session";
import { readerWords } from "@/lib/i18n/reader-words";
import { getMetricSeries } from "@/lib/metrics-history-service";
import { hostSubject, resolveRange } from "@/lib/metrics-shared";
import { COMPARE_MAX, rangeSchema, serverIdsSchema } from "@/lib/server-insights/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Two to four servers' load over one window, in one round trip, so they can be
 *  drawn on shared axes (?ids=local,<host id>&range=1h|6h|1d|7d|30d). */
export async function GET(request: Request): Promise<Response> {
    const user = await apiPermission("system.manage");
    if (user instanceof Response) return user;
    const t = await readerWords("api");
    const params = new URL(request.url).searchParams;
    const ids = serverIdsSchema(COMPARE_MAX).safeParse(params.get("ids") ?? "");
    const range = rangeSchema.safeParse(params.get("range"));
    if (!ids.success || !range.success)
        return Response.json({ error: t("errors.invalidRequest") }, { status: 400 });
    const { from, to } = resolveRange(range.data, null, null);
    const series = await Promise.all(
        ids.data.map((id) =>
            getMetricSeries({
                subjectType: "host",
                subjectId: hostSubject(id),
                ownerId: user.id,
                from,
                to
            })
        )
    );
    if (series.includes(null))
        return Response.json({ error: t("errors.notFound") }, { status: 404 });
    return Response.json({
        from: from.getTime(),
        to: to.getTime(),
        servers: ids.data.map((id, index) => ({ id, points: series[index]! }))
    });
}
