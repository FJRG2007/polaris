/**
 * Activity admin (/admin/activity): the global audit trail.
 *
 * The page itself only clears the admin gate; the rows are read from
 * /api/admin/activity once the screen is on. Reading two hundred entries and
 * resolving their actors here would have held the whole navigation back, and it
 * is the one thing on the screen that has to wait for the database.
 */

import { requireAdmin } from "@/lib/session";
import { ActivityView } from "./activity-view";

export const dynamic = "force-dynamic";

export default async function ActivityPage() {
    await requireAdmin();
    return <ActivityView />;
}
