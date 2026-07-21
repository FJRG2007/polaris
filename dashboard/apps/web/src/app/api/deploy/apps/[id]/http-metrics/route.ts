import { requirePermission } from "@/lib/session";
import { readAppHttpMetrics } from "@/lib/deploy-service";
import { resolveRange } from "@/lib/metrics-shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** HTTP traffic time series for a deployed app (requests, 5xx error rate, response
 *  time, egress throughput), derived from its access logs, over a preset
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
    try {
        const points = await readAppHttpMetrics(id, user.id, from.getTime(), to.getTime());
        return Response.json({ points });
    } catch (caught) {
        return Response.json(
            { error: caught instanceof Error ? caught.message : "Could not read HTTP metrics" },
            { status: 400 }
        );
    }
}
