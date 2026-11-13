/**
 * Work out every active route's percentiles and flag the slow ones, on demand.
 *
 * Polaris runs this on its own schedule (see `lib/cron/scheduler`); the route is
 * for an operator who would rather drive the timing, and goes through the same
 * job runner so both paths behave identically.
 *
 * Disabled unless POLARIS_CRON_SECRET is set, and callers present it as a bearer
 * token (or an x-cron-key header). Node runtime for Prisma.
 */

import { authorizeCron } from "@/lib/cron/authorize";
import { runScheduledJob } from "@/lib/cron/scheduler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
    const refused = authorizeCron(request);
    if (refused) return refused;

    const result = await runScheduledJob("telemetry-performance");
    return Response.json(result ?? { skipped: "already running" });
}
