/**
 * Run the automations pass (schedules, the outbox, due waits, runs) on demand.
 *
 * Polaris runs this itself every five seconds (see `lib/cron/scheduler`); the
 * route stays for an operator who would rather drive the timing from outside,
 * like every other scheduled job.
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

    const result = await runScheduledJob("automations");
    return Response.json(result === null ? { skipped: "already running" } : result);
}
