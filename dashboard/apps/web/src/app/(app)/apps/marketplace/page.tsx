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
 *
 * An app that is on for the whole Polaris (`instanceWide`) is installed for every
 * reader, whoever installed it. `?app=<id>` opens the page on that app, which is
 * how an app's own screen sends somebody here to install it.
 */

import { findApp } from "@/lib/apps/catalog";
import { requirePermission } from "@/lib/session";
import { MarketplaceView } from "./marketplace-view";
import { gameForCatalogId } from "@/lib/apps/games-catalog";
import { adoptGameServersApp } from "@/lib/apps/game-install";
import { adoptMailServerApp } from "@/lib/mail-server/app-install";
import { instanceWideInstallIds, listInstalledApps } from "@/lib/apps/install-service";

export const dynamic = "force-dynamic";

export default async function MarketplacePage({
    searchParams
}: {
    searchParams: Promise<{ app?: string | string[] }>;
}) {
    const user = await requirePermission("deploy.read");
    // An instance built when each game was its own app is folded into the one that
    // replaced them, here as well as on the Game servers page - this is the other
    // screen where the old rows would still be visible. The same for a mail server
    // that was running before it was an app.
    await Promise.all([adoptGameServersApp(user.id), adoptMailServerApp()]);
    const installed = await listInstalledApps(user.id, await instanceWideInstallIds());
    const { app } = await searchParams;
    const focus = typeof app === "string" ? findApp(app) : undefined;
    return (
        <MarketplaceView
            installed={installed.filter((item) => gameForCatalogId(item.catalogId) === undefined)}
            initialQuery={focus?.name ?? ""}
        />
    );
}
