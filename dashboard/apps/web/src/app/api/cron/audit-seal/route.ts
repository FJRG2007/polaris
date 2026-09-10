/**
 * Seal the audit entries written since the last pass into the tamper-evident
 * chain - on demand.
 *
 * Polaris' own scheduler runs this every minute (see `lib/cron/scheduler`) and
 * it costs nothing once nothing is waiting. The route stays for an operator who
 * would rather drive the timing themselves.
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

    const result = await runScheduledJob("audit-seal");
    return Response.json(result === null ? { skipped: "already running" } : result);
}
