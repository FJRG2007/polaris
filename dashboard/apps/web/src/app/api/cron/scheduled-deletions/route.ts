/**
 * Cron endpoint that runs every due scheduled deletion across all connections, for
 * exact timing without an always-on scheduler. Disabled unless POLARIS_CRON_SECRET
 * is set; when set, callers must present it as a bearer token (or x-cron-key
 * header). Point an external scheduler at this route to fire deletions on time;
 * without it, due deletions still run lazily as connections are browsed. Node
 * runtime for Prisma and the drivers.
 */

import { loadEnv } from "@polaris/config";
import { sweepDueDeletions } from "@/lib/scheduled-deletion-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function presentedToken(request: Request): string {
    const auth = request.headers.get("authorization") ?? "";
    if (auth.startsWith("Bearer ")) return auth.slice(7).trim();
    return request.headers.get("x-cron-key")?.trim() ?? "";
}

export async function POST(request: Request): Promise<Response> {
    const secret = loadEnv().POLARIS_CRON_SECRET;
    if (!secret) return Response.json({ error: "Scheduled-deletion cron is not configured." }, { status: 503 });
    if (presentedToken(request) !== secret) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    const processed = await sweepDueDeletions();
    return Response.json({ processed });
}
