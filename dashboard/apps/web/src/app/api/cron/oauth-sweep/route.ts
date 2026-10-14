/**
 * Remove what the MCP sign-in flow no longer needs, on demand: expired codes and
 * tokens, disconnected connections past their grace, app registrations nobody
 * approved, and rate-limit windows that have run out.
 *
 * Polaris runs this on its own schedule too (see `lib/cron/scheduler`). The route
 * is for an operator who would rather drive the timing themselves.
 *
 * Disabled unless POLARIS_CRON_SECRET is set; when set, callers must present it
 * as a bearer token (or x-cron-key header). Node runtime for Prisma.
 */

import { authorizeCron } from "@/lib/cron/authorize";
import { runScheduledJob } from "@/lib/cron/scheduler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
    const refused = authorizeCron(request);
    if (refused) return refused;

    const processed = await runScheduledJob("oauth-sweep");
    return Response.json(processed === null ? { skipped: "already running" } : { processed });
}
