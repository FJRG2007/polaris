/**
 * The Apps marketplace. Browse the catalog of apps Polaris can install and run,
 * and see what is already installed. Browsing needs deploy.read; the install
 * wizard's actions are separately gated on deploy.manage.
 */

import { requirePermission } from "@/lib/session";
import { listInstalledApps } from "@/lib/apps/install-service";
import { MarketplaceView } from "./marketplace-view";

export const dynamic = "force-dynamic";

export default async function MarketplacePage() {
    const user = await requirePermission("deploy.read");
    const installed = await listInstalledApps(user.id);
    return <MarketplaceView installed={installed} />;
}
