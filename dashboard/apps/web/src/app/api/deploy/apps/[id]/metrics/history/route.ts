import { apiPermission } from "@/lib/api-session";
import { resolveRange } from "@/lib/metrics-shared";
import { getMetricSeries } from "@/lib/metrics-history-service";
import { requireApplicationAccess } from "@/lib/deploy-project-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Downsampled consumption history for a deployed app's container, over a preset
 *  (?range=1h|6h|1d|7d|30d) or custom window (?from=&to= in epoch ms). */
export async function GET(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
    const user = await apiPermission("deploy.read");
    if (user instanceof Response) return user;
    const { id } = await params;
    // The series belongs to the project, not to the reader: check the reader's
    // standing on it, then read as the owner - as the volume series does.
    const access = await requireApplicationAccess(id, user.id, "project.read").catch(() => null);
    if (!access) return Response.json({ error: "Not found" }, { status: 404 });
    const url = new URL(request.url);
    const { from, to } = resolveRange(
        url.searchParams.get("range"),
        url.searchParams.get("from"),
        url.searchParams.get("to")
    );
    const points = await getMetricSeries({ subjectType: "app", subjectId: id, ownerId: access.ownerId, from, to });
    if (points === null) return Response.json({ error: "Not found" }, { status: 404 });
    return Response.json({ points });
}
