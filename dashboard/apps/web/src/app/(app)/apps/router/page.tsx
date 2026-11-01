/**
 * Router (/apps/router): an enrolled Linux machine as the network's router, set up
 * and watched from here. An administrator's: it decides what every device can reach.
 */

import { requireAdmin } from "@/lib/session";
import { RouterSection } from "./router-view";

export const dynamic = "force-dynamic";

export default async function RouterPage() {
    await requireAdmin();
    return <RouterSection />;
}
