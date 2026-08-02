import { requirePermission } from "@/lib/session";
import { resolveRange } from "@/lib/metrics-shared";
import { getMetricSeries } from "@/lib/metrics-history-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A server's load history over a preset (?range=1h|6h|1d|7d|30d) or a custom
 *  window (?from=&to= in epoch ms). Ownership is checked by the series reader. */
export async function GET(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
    const user = await requirePermission("deploy.read");
    const { id } = await params;
    const url = new URL(request.url);
    const { from, to } = resolveRange(
        url.searchParams.get("range"),
        url.searchParams.get("from"),
        url.searchParams.get("to")
    );
    const points = await getMetricSeries({ subjectType: "host", subjectId: id, ownerId: user.id, from, to });
    if (points === null) return Response.json({ error: "Not found" }, { status: 404 });
    return Response.json({ points });
}
