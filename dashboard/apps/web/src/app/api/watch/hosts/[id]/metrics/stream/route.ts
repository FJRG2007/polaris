import { apiPermission } from "@/lib/api-session";
import { hostSubject } from "@/lib/metrics-shared";
import { metricTickStream, subjectKey } from "@/lib/metrics-live";
import { subjectBelongsToOwner } from "@/lib/metrics-history-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Says when a server has a new load sample to draw. `local` is the machine
 *  Polaris runs on, filed under its reserved subject. Authorized like the history
 *  it wakes. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
    const user = await apiPermission("deploy.read");
    if (user instanceof Response) return user;
    const { id } = await params;
    const subject = hostSubject(id);
    if (!(await subjectBelongsToOwner("host", subject, user.id).catch(() => false))) {
        return Response.json({ error: "Not found" }, { status: 404 });
    }
    return metricTickStream(request, [subjectKey("host", subject)]);
}
