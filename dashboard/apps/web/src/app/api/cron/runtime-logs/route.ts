/**
 * Keep what every running service printed since the last capture, on demand.
 *
 * Polaris' own scheduler already does this every minute (see `lib/cron`); the
 * route stays for an operator who would rather drive the timing themselves. The
 * pass takes the job's lease, so this and the internal tick never store the same
 * lines twice.
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

    const result = await runScheduledJob("runtime-logs");
    return Response.json(result === null ? { skipped: "already running" } : result);
}
