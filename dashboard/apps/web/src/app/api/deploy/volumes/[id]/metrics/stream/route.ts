import { apiPermission } from "@/lib/api-session";
import { getVolumeOwner } from "@/lib/deploy-service";
import { metricTickStream, subjectKey } from "@/lib/metrics-live";
import { requireApplicationAccess } from "@/lib/deploy-project-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Says when a volume has a new measurement to draw. Authorized like the history
 *  it wakes: the reader's standing on the project that mounts it. */
export async function GET(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
    const user = await apiPermission("deploy.read");
    if (user instanceof Response) return user;
    const { id } = await params;
    const owner = await getVolumeOwner(id);
    if (!owner) return Response.json({ error: "Not found" }, { status: 404 });
    if (owner.applicationId) {
        const access = await requireApplicationAccess(
            owner.applicationId,
            user.id,
            "project.read"
        ).catch(() => null);
        if (!access) return Response.json({ error: "Not found" }, { status: 404 });
    } else if (owner.ownerId !== user.id) {
        return Response.json({ error: "Not found" }, { status: 404 });
    }
    return metricTickStream(request, [subjectKey("volume", id)]);
}
