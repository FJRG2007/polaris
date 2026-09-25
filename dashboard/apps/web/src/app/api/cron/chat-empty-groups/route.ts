/**
 * Remove chat groups nobody is in any more - emptied by an account being
 * deleted rather than by its last member leaving, which removes it at once.
 *
 * Polaris runs it on its own schedule (see `lib/cron/scheduler`). The route stays
 * for an operator who would rather drive the timing themselves.
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

    const swept = await runScheduledJob("chat-empty-groups");
    return Response.json(swept ?? { skipped: "already running" });
}
