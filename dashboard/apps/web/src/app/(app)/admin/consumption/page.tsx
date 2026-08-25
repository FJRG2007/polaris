/**
 * Consumption (/admin/consumption): what this machine is being spent on.
 *
 * The page itself only clears the admin gate. Every figure on it is read from
 * /api/admin/consumption and /api/polaris/footprint once the screen is on -
 * listing an engine's containers and measuring the stack's volumes are the two
 * slowest reads in the dashboard, and neither may hold a navigation.
 */

import { requireAdmin } from "@/lib/session";
import { ConsumptionView } from "./consumption-view";

export const dynamic = "force-dynamic";

export default async function ConsumptionPage() {
    await requireAdmin();
    return <ConsumptionView />;
}
