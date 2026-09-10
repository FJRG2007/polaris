import { prisma } from "@polaris/db";
import { apiPermission } from "@/lib/api-session";
import { metricTickStream, subjectKey } from "@/lib/metrics-live";
import { requireApplicationAccess } from "@/lib/deploy-project-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Says when a service's charts have new samples to draw: its own, or one of the
 *  volumes it mounts, whose disk its Storage chart lays over it. Authorized like
 *  the history it wakes. */
export async function GET(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
    const user = await apiPermission("deploy.read");
    if (user instanceof Response) return user;
    const { id } = await params;
    const access = await requireApplicationAccess(id, user.id, "project.read").catch(() => null);
    if (!access) return Response.json({ error: "Not found" }, { status: 404 });
    const volumes = await prisma.volume.findMany({
        where: { applicationId: id },
        select: { id: true }
    });
    return metricTickStream(request, [
        subjectKey("app", id),
        ...volumes.map((volume) => subjectKey("volume", volume.id))
    ]);
}
