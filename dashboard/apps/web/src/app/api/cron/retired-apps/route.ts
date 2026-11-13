/**
 * Uninstall the apps Polaris no longer ships, on demand.
 *
 * Polaris runs this on its own schedule (see `lib/cron/scheduler`), hourly, so
 * an update takes a retired app down soon after it boots.
 *
 * Disabled unless POLARIS_CRON_SECRET is set; when set, callers must present it
 * as a bearer token (or x-cron-key header). Node runtime for Prisma.
 */

import { authorizeCron } from "@/lib/cron/authorize";
import { runScheduledJob } from "@/lib/cron/scheduler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
    const refused = authorizeCron(request);
    if (refused) return refused;

    const retired = await runScheduledJob("retired-apps");
    return Response.json(retired ?? { skipped: "already running" });
}
