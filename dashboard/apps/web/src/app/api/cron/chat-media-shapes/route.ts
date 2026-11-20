/**
 * Measure a batch of pictures sent before they carried their size and blur, on
 * demand.
 *
 * Polaris' own scheduler runs this in the background (see `lib/cron/scheduler`
 * and `lib/chat/media-backfill`). The route stays for an operator who would
 * rather drive the timing themselves.
 *
 * Disabled unless POLARIS_CRON_SECRET is set, and callers present it as a bearer
 * token (or an x-cron-key header). Node runtime for Prisma and sharp.
 */

import { authorizeCron } from "@/lib/cron/authorize";
import { runScheduledJob } from "@/lib/cron/scheduler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
    const refused = authorizeCron(request);
    if (refused) return refused;

    const result = await runScheduledJob("chat-media-shapes");
    return Response.json(result === null ? { skipped: "already running" } : result);
}
