/**
 * Polaris apps: the marketplace of Polaris's own apps, switched on for the whole
 * instance by an administrator, beside the ones every Polaris comes with. Other
 * developers' software stays at /apps/marketplace.
 *
 * Admin-only: an app installed here is on for everybody. `?app=<id>` opens the
 * page on that app, which is how an app's own screen sends somebody here to
 * install it; one naming another developer's app lands on the user marketplace.
 */

import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/session";
import { adoptAppInstalls } from "@/lib/app-extensions/registry";
import { adoptMailServerApp } from "@/lib/mail-server/app-install";
import { storeInstalls } from "@/app/(app)/apps/marketplace/store-installs";
import { MarketplaceView } from "@/app/(app)/apps/marketplace/marketplace-view";
import { DEPLOYABLE_APPS_PATH, storeScope, findStoreApp } from "@/lib/apps/marketplace-store";

export const dynamic = "force-dynamic";

export default async function PolarisAppsPage({
    searchParams
}: {
    searchParams: Promise<{ app?: string | string[] }>;
}) {
    const user = await requireAdmin();
    await Promise.all([adoptAppInstalls(user.id), adoptMailServerApp()]);
    const { app } = await searchParams;
    const focus = typeof app === "string" ? findStoreApp(app) : undefined;
    if (focus && storeScope(focus) === "deployable")
        redirect(`${DEPLOYABLE_APPS_PATH}?app=${encodeURIComponent(focus.id)}`);
    const { installed, canInstall } = await storeInstalls(user, "polaris");
    return (
        <MarketplaceView
            scope="polaris"
            installed={installed}
            initialQuery={focus?.name ?? ""}
            canInstall={canInstall}
        />
    );
}
