
import { getMetricSeries } from "@/lib/metrics-history-service";
import { apiUser } from "@/lib/api-session";
import { serverMetricsOwner } from "@/lib/machines/machine-access";
import { hostSubject, resolveRange } from "@/lib/metrics-shared";
import { readerWords } from "@/lib/i18n/reader-words";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A server's load history over a preset (?range=1h|6h|1d|7d|30d) or a custom
 *  window (?from=&to= in epoch ms). `local` is the machine Polaris runs on, whose
 *  samples are filed under a reserved subject id. The reader's own server, or
 *  one lent to them in Places, read as its owner's. */
export async function GET(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
    const user = await apiUser();
    if (user instanceof Response) return user;
    const { id } = await params;
    const ownerId = await serverMetricsOwner(user, id);
    if (!ownerId) return Response.json({ error: (await readerWords("api"))("errors.notFound") }, { status: 404 });
    const url = new URL(request.url);
    const { from, to } = resolveRange(
        url.searchParams.get("range"),
        url.searchParams.get("from"),
        url.searchParams.get("to")
    );
    const points = await getMetricSeries({
        subjectType: "host",
        subjectId: hostSubject(id),
        ownerId,
        from,
        to
    });
    if (points === null) return Response.json({ error: (await readerWords("api"))("errors.notFound") }, { status: 404 });
    return Response.json({ points });
}
