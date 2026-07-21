import { requirePermission } from "@/lib/session";
import { getMetricSeries } from "@/lib/metrics-history-service";
import { resolveRange } from "@/lib/metrics-shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Downsampled consumption history for a deployed app's container, over a preset
 *  (?range=1h|6h|1d|7d|30d) or custom window (?from=&to= in epoch ms). */
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
    const points = await getMetricSeries({ subjectType: "app", subjectId: id, ownerId: user.id, from, to });
    if (points === null) return Response.json({ error: "Not found" }, { status: 404 });
    return Response.json({ points });
}
