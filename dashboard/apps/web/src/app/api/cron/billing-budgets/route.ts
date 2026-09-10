/**
 * Measure every organization's budget against this month's spend, on demand.
 *
 * Polaris runs this on its own schedule (see `lib/cron/scheduler`); the route is
 * for an operator who drives the timing from outside, and goes through the same
 * job runner so both paths take the same claim. Disabled unless
 * POLARIS_CRON_SECRET is set.
 */

import { authorizeCron } from "@/lib/cron/authorize";
import { runScheduledJob } from "@/lib/cron/scheduler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
    const refused = authorizeCron(request);
    if (refused) return refused;

    const swept = await runScheduledJob("billing-budgets");
    return Response.json(swept ?? { skipped: "already running" });
}
