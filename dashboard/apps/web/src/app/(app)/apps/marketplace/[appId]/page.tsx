/**
 * One app's page in the Marketplace: what it is, what it does, what it looks
 * like, and the Install / Open / Uninstall buttons, the way a store's product
 * page puts them.
 *
 * The manifest is static, so everything about the app paints at once; only the
 * part that depends on this Polaris - whether it is installed, and what this
 * reader may do about it - waits, behind its own skeleton. Browsing needs
 * deploy.read like the grid; installing and uninstalling are offered from the
 * same checks the actions enforce.
 */

import { Suspense } from "react";
import { requirePermission } from "@/lib/session";
import { AppInstallState } from "../store-installs";
import { notFound, redirect } from "next/navigation";
import { isNativeApp } from "@/lib/apps/native-apps";
import { AppDetail, AppInstallPanelSkeleton } from "./app-detail";
import { listingHref, storeScope, findStoreApp } from "@/lib/apps/marketplace-store";

export const dynamic = "force-dynamic";

export default async function MarketplaceAppPage({
    params
}: {
    params: Promise<{ appId: string }>;
}) {
    const user = await requirePermission("deploy.read");
    const { appId } = await params;
    const app = findStoreApp(appId);
    // A helper another app runs is not offered on its own, here or in the grid.
    if (!app || app.internal) notFound();
    // Part of Servers on every Polaris: old links to its marketplace page open it.
    if (isNativeApp(app.id) && app.opensAt) redirect(app.opensAt);
    // Polaris's own apps have their page on the admin screen; old links open it.
    if (storeScope(app) === "polaris") redirect(listingHref(app));
    return (
        <AppDetail appId={app.id}>
            <Suspense fallback={<AppInstallPanelSkeleton />}>
                <AppInstallState appId={app.id} user={user} />
            </Suspense>
        </AppDetail>
    );
}
