import { apiUser } from "@/lib/api-session";
import { serverMetricsOwner } from "@/lib/machines/machine-access";
import { hostSubject } from "@/lib/metrics-shared";
import { metricTickStream, subjectKey } from "@/lib/metrics-live";
import { readerWords } from "@/lib/i18n/reader-words";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Says when a server has a new load sample to draw. `local` is the machine
 *  Polaris runs on, filed under its reserved subject. Authorized like the history
 *  it wakes: the reader's own server, or one lent to them. */
export async function GET(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
    const user = await apiUser();
    if (user instanceof Response) return user;
    const { id } = await params;
    const subject = hostSubject(id);
    if (!(await serverMetricsOwner(user, id))) {
        return Response.json(
            { error: (await readerWords("api"))("errors.notFound") },
            { status: 404 }
        );
    }
    return metricTickStream(request, [subjectKey("host", subject)]);
}
