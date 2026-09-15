/**
 * Archive the game worlds whose schedule says a copy is due, and prune the ones
 * that have fallen out of retention.
 *
 * Separate from `backups`, which is driven by a protected resource's own due
 * date. A world has no such row: its schedule lives in the install's config and
 * the only record of when the last copy was taken is the archive sitting beside
 * the world. Without this pass the schedule on the Backups card is a date nobody
 * ever acts on.
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

    const swept = await runScheduledJob("game-world-backups");
    return Response.json(swept ?? { skipped: "already running" });
}
