/**
 * Everything the console's chrome needs in one request: the summary numbers, the
 * plans, and the destinations.
 *
 * One route rather than three, because all three land in the same render and
 * three round trips would paint the filters, then the plan names, then the
 * destination names, each a frame apart. The rows themselves are a separate
 * request - they are the part that pages.
 *
 * Admin-only. Node runtime for Prisma.
 */

import { requireAdmin } from "@/lib/session";
import { adoptLegacyBackups } from "@/lib/backups/adoption";
import { ensureDefaultDestinations } from "@/lib/backups/service";
import { backupSummary, listDestinations, listPlans } from "@/lib/backups/manage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
    const user = await requireAdmin();
    // The first visit is where an owner gets somewhere to put a backup. Doing it
    // here rather than in a migration means it happens for an account created
    // later too, and it is a no-op every time after the first.
    await ensureDefaultDestinations(user.id);
    // Then take over whatever the old feature left behind - the loose dumps in
    // the data dir and the world schedules hidden in each app's config. Once per
    // owner, and never a reason the screen fails to open.
    await adoptLegacyBackups(user.id).catch(() => undefined);
    const [summary, plans, destinations] = await Promise.all([
        backupSummary(user.id),
        listPlans(user.id),
        listDestinations(user.id)
    ]);
    return Response.json({ summary, plans, destinations });
}
