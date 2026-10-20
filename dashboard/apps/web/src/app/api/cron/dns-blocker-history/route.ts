/**
 * Roll the ad blocker's finished days up into its long-term statistics
 * - on demand.
 *
 * Polaris' own scheduler runs this every hour (see
 * `lib/cron/scheduler`) and a day already rolled up costs one read. The
 * route stays for an operator who would rather drive the timing themselves.
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

    const result = await runScheduledJob("dns-blocker-history");
    return Response.json(result === null ? { skipped: "already running" } : result);
}
