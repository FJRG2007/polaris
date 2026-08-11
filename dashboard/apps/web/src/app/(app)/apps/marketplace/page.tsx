/**
 * The Apps marketplace. Browse the catalog of apps Polaris can install and run,
 * and see what is already installed. Browsing needs deploy.read; the install
 * wizard's actions are separately gated on deploy.manage.
 *
 * What "installed" means here is one row per app somebody chose, not one per
 * thing Polaris happens to be running for them. A game server is created from
 * inside Game servers and is listed there, with its own address and console; a
 * marketplace that also listed every one of them turned into a second, worse copy
 * of that page - five rows called Minecraft, ARK and "tonto" under a heading that
 * is supposed to say what this Polaris has been given.
 */

import { requirePermission } from "@/lib/session";
import { MarketplaceView } from "./marketplace-view";
import { gameForCatalogId } from "@/lib/apps/games-catalog";
import { adoptGameServersApp } from "@/lib/apps/game-install";
import { listInstalledApps } from "@/lib/apps/install-service";

export const dynamic = "force-dynamic";

export default async function MarketplacePage() {
    const user = await requirePermission("deploy.read");
    // An instance built when each game was its own app is folded into the one that
    // replaced them, here as well as on the Game servers page - this is the other
    // screen where the old rows would still be visible.
    await adoptGameServersApp(user.id);
    const installed = await listInstalledApps(user.id);
    return <MarketplaceView installed={installed.filter((item) => gameForCatalogId(item.catalogId) === undefined)} />;
}
