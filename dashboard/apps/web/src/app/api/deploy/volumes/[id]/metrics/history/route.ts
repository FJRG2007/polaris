import { requirePermission } from "@/lib/session";
import { resolveRange } from "@/lib/metrics-shared";
import { getVolumeOwner } from "@/lib/deploy-service";
import { getMetricSeries } from "@/lib/metrics-history-service";
import { requireApplicationAccess } from "@/lib/deploy-project-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** How full a volume has been over a preset (?range=1h|6h|1d|7d|30d) or custom
 *  window (?from=&to= in epoch ms). Samples are taken from inside the service
 *  that mounts it, so a volume on a stopped service simply has gaps. */
export async function GET(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
    const user = await requirePermission("deploy.read");
    const { id } = await params;

    // The series belongs to the project, not to the reader: resolve who owns the
    // volume, check the reader's standing on that project, then read as the owner.
    const owner = await getVolumeOwner(id);
    if (!owner) return Response.json({ error: "Not found" }, { status: 404 });
    if (owner.applicationId) {
        try {
            await requireApplicationAccess(owner.applicationId, user.id, "viewer");
        } catch {
            return Response.json({ error: "Not found" }, { status: 404 });
        }
    } else if (owner.ownerId !== user.id) {
        return Response.json({ error: "Not found" }, { status: 404 });
    }

    const url = new URL(request.url);
    const { from, to } = resolveRange(
        url.searchParams.get("range"),
        url.searchParams.get("from"),
        url.searchParams.get("to")
    );
    const points = await getMetricSeries({
        subjectType: "volume",
        subjectId: id,
        ownerId: owner.ownerId,
        from,
        to
    });
    if (points === null) return Response.json({ error: "Not found" }, { status: 404 });
    return Response.json({ points });
}
