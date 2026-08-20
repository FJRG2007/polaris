/**
 * Send every scheduled message that has come due, on demand.
 *
 * A message written for nine in the morning has to go at nine whether or not
 * anybody has the dashboard open, which is what Polaris' own scheduler is for
 * (see `lib/cron/scheduler`). The route stays for an operator who would rather
 * drive the timing themselves.
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

    const result = await runScheduledJob("chat-scheduled");
    return Response.json(result === null ? { skipped: "already running" } : result);
}
