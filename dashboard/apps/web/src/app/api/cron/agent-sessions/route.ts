/**
 * Close the agent sessions whose machine has stopped reporting, on demand.
 *
 * Polaris runs this on its own schedule (see `lib/cron/scheduler`), so a session
 * whose container was reaped does not sit at the top of the list forever on an
 * instance nobody has wired anything to. The route stays for an operator who
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

    const closed = await runScheduledJob("agent-sessions");
    return Response.json(closed === null ? { skipped: "already running" } : { closed });
}
