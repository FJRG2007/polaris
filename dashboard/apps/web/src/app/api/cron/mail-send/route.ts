/**
 * Send every queued message whose hour has come, on demand.
 *
 * The safety net under the in-process timer: a message queued a moment before a
 * restart goes late rather than never. The route stays for an operator driving
 * the timing themselves.
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

    const result = await runScheduledJob("mail-send");
    return Response.json(result === null ? { skipped: "already running" } : result);
}
