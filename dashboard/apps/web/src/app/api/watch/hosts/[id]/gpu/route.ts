import { apiPermission } from "@/lib/api-session";
import { machineGpus } from "@/lib/gpu/gpu-live";
import { readerWords } from "@/lib/i18n/reader-words";
import { hostSubject } from "@/lib/metrics-shared";
import { machineGpuView } from "@/lib/gpu/gpu-view";
import { subjectBelongsToOwner } from "@/lib/metrics-history-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A server's NVIDIA cards as the collector last read them, card by card, with
 *  the containers on them. Read from memory, never probed, so a page open on a
 *  machine that is off answers at once. `local` is the machine Polaris runs on.
 *  Asked and owned the same way as the server's load history. */
export async function GET(
    _request: Request,
    { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
    const user = await apiPermission("deploy.read");
    if (user instanceof Response) return user;
    const { id } = await params;
    const subjectId = hostSubject(id);
    if (!(await subjectBelongsToOwner("host", subjectId, user.id))) {
        return Response.json({ error: (await readerWords("api"))("errors.notFound") }, { status: 404 });
    }
    return Response.json(machineGpuView(machineGpus(subjectId)));
}
