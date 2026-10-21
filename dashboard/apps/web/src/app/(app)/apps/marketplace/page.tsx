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
import { requirePermission, sessionCan } from "@/lib/session";
import { MarketplaceView } from "./marketplace-view";
import { gameForCatalogId } from "@/lib/apps/games-catalog";
import { adoptAppInstalls } from "@/lib/app-extensions/registry";
import { adoptMailServerApp } from "@/lib/mail-server/app-install";
import { uninstallAccess } from "@/lib/apps/install-access";
import {
    installForReader,
    instanceWideInstallIds,
    listInstalledApps
} from "@/lib/apps/install-service";

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
    await Promise.all([adoptAppInstalls(user.id), adoptMailServerApp()]);
    const installed = await listInstalledApps(user.id, await instanceWideInstallIds());
    const { app } = await searchParams;
    const focus = typeof app === "string" ? findApp(app) : undefined;
    // Somebody else's install is cut to what this reader may be sent. Whether
    // they may uninstall each one is the uninstall action's own check, so the
    // grid offers Uninstall exactly where it would work.
    const [canInstall, shown] = await Promise.all([
        sessionCan(user, "deploy.manage"),
        Promise.all(
            installed
                .filter((item) => gameForCatalogId(item.catalogId) === undefined)
                .map(async (item) => {
                    const canUninstall =
                        (await uninstallAccess(user, item.id).catch(() => null)) !== null;
                    return { ...installForReader(item, user.id, canUninstall), canUninstall };
                })
        )
    ]);
    return (
        <MarketplaceView
            installed={shown}
            initialQuery={focus?.name ?? ""}
            canInstall={canInstall}
        />
    );
}
