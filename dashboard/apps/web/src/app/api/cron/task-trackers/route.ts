/**
 * Pull every connected Linear and Jira once, on demand.
 *
 * Polaris runs this on its own schedule (see `lib/cron/scheduler`), so a
 * connected tracker stays in step on an instance nobody has wired anything to.
 * The route stays for an operator who would rather drive the timing themselves -
 * or who wants everything pulled right now after fixing a credential.
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

    const pulled = await runScheduledJob("task-trackers");
    return Response.json(pulled === null ? { skipped: "already running" } : { pulled });
}
