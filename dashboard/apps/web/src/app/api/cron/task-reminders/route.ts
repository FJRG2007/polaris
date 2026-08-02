/**
 * Cron endpoint that sends every task reminder that has come due.
 *
 * A reminder has to fire whether or not anybody has the dashboard open, so it is
 * driven from outside rather than by a timer in a request. Same contract as the
 * other cron routes: disabled unless POLARIS_CRON_SECRET is set, and callers
 * present it as a bearer token (or an x-cron-key header). Node runtime for
 * Prisma.
 */

import { loadEnv } from "@polaris/config";
import { dispatchDueReminders } from "@/lib/tasks/task-detail-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function presentedToken(request: Request): string {
    const auth = request.headers.get("authorization") ?? "";
    if (auth.startsWith("Bearer ")) return auth.slice(7).trim();
    return request.headers.get("x-cron-key")?.trim() ?? "";
}

export async function POST(request: Request): Promise<Response> {
    const secret = loadEnv().POLARIS_CRON_SECRET;
    if (!secret) return Response.json({ error: "Task reminders are not configured." }, { status: 503 });
    if (presentedToken(request) !== secret) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    const sent = await dispatchDueReminders();
    return Response.json({ sent });
}
