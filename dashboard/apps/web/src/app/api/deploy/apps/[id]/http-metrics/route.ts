import { apiPermission } from "@/lib/api-session";
import { resolveRange } from "@/lib/metrics-shared";
import { readAppHttpMetrics } from "@/lib/deploy-service";
import { requireApplicationAccess } from "@/lib/deploy-project-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** HTTP traffic time series for a deployed app (requests, 5xx error rate, response
 *  time, egress throughput), derived from its access logs, over a preset
 *  (?range=1h|6h|1d|7d|30d) or custom window (?from=&to= in epoch ms). */
export async function GET(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
    const user = await apiPermission("deploy.read");
    if (user instanceof Response) return user;
    const { id } = await params;
    // As whoever owns the project, once the reader's standing on it is checked.
    const access = await requireApplicationAccess(id, user.id, "project.read").catch(() => null);
    if (!access) return Response.json({ error: "Service not found" }, { status: 404 });
    const url = new URL(request.url);
    const { from, to } = resolveRange(
        url.searchParams.get("range"),
        url.searchParams.get("from"),
        url.searchParams.get("to")
    );
    try {
        const points = await readAppHttpMetrics(id, access.ownerId, from.getTime(), to.getTime());
        return Response.json({ points });
    } catch (caught) {
        return Response.json(
            { error: caught instanceof Error ? caught.message : "Could not read HTTP metrics" },
            { status: 400 }
        );
    }
}
