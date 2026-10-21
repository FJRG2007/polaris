/**
 * Check the network filter's newly seen domains against Dymo's reputation
 * - on demand.
 *
 * Polaris' own scheduler runs this every five minutes (see
 * `lib/cron/scheduler`), and a pass with the lookups off reads two rows. The
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

    const result = await runScheduledJob("dns-blocker-reputation");
    return Response.json(result === null ? { skipped: "already running" } : result);
}
