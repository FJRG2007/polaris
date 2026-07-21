import { userHasPermission } from "@polaris/auth";
import { requireUser } from "@/lib/session";
import { getMetricSeries } from "@/lib/metrics-history-service";
import { resolveRange } from "@/lib/metrics-shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Downsampled consumption history for a Drive storage connection (NAS/server),
 *  over a preset (?range=1h|6h|1d|7d|30d) or custom window (?from=&to= epoch ms). */
export async function GET(request: Request): Promise<Response> {
    const user = await requireUser();
    if (!(await userHasPermission(user.id, "drive.read"))) {
        return Response.json({ error: "Forbidden" }, { status: 403 });
    }
    const url = new URL(request.url);
    const connectionId = url.searchParams.get("c");
    if (!connectionId) return Response.json({ error: "Missing connection" }, { status: 400 });

    const { from, to } = resolveRange(
        url.searchParams.get("range"),
        url.searchParams.get("from"),
        url.searchParams.get("to")
    );
    const points = await getMetricSeries({ subjectType: "storage", subjectId: connectionId, ownerId: user.id, from, to });
    if (points === null) return Response.json({ error: "Not found" }, { status: 404 });
    return Response.json({ points });
}
