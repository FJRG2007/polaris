/**
 * The Apps marketplace: other developers' software Polaris can deploy and run
 * for you, and what of it is already installed. Polaris's own apps are switched
 * on from Administration (/admin/apps), so they are not listed here. Browsing
 * needs deploy.read; the install wizard's actions are separately gated on
 * deploy.manage.
 *
 * What "installed" means here is one row per app somebody chose, not one per
 * thing Polaris happens to be running for them. A game server is created from
 * inside Game servers and is listed there, with its own address and console; a
 * marketplace that also listed every one of them turned into a second, worse copy
 * of that page.
 *
 * `?app=<id>` opens the page on that app, which is how an app's own screen sends
 * somebody here to install it; one naming a Polaris app lands on the admin screen.
 */

import { redirect } from "next/navigation";
import { openableBuiltIns, storeInstalls } from "./store-installs";
import { requirePermission } from "@/lib/session";
import { MarketplaceView } from "./marketplace-view";
import { adoptAppInstalls } from "@/lib/app-extensions/registry";
import { adoptMailServerApp } from "@/lib/mail-server/app-install";
import { polarisAppsHref, storeScope, findStoreApp } from "@/lib/apps/marketplace-store";

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
    const { app } = await searchParams;
    const focus = typeof app === "string" ? findStoreApp(app) : undefined;
    if (focus && storeScope(focus) === "polaris") redirect(polarisAppsHref(focus.id));
    const [{ installed, canInstall }, openable] = await Promise.all([
        storeInstalls(user, "deployable"),
        openableBuiltIns(user)
    ]);
    return (
        <MarketplaceView
            installed={installed}
            initialQuery={focus?.name ?? ""}
            canInstall={canInstall}
            canBrowsePolaris={user.isAdmin}
            openableBuiltIns={openable}
        />
    );
}
