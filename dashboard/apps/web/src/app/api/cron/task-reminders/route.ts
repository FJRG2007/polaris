/**
 * Send every task reminder that has come due, on demand.
 *
 * A reminder has to fire whether or not anybody has the dashboard open, which is
 * why it was driven from outside. Polaris now runs it on its own schedule (see
 * `lib/cron/scheduler`), so a reminder set for half past two arrives at half past
 * two on an instance nobody has wired anything to. The route stays for an operator
 * who would rather drive the timing themselves.
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

    const sent = await runScheduledJob("task-reminders");
    return Response.json(sent === null ? { skipped: "already running" } : { sent });
}
