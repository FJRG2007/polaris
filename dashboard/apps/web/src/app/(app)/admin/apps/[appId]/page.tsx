/**
 * One Polaris app's page: the same store page as /apps/marketplace/<id>, on the
 * admin screen that lists it. Admin-only, like the grid. Another developer's
 * app has its page in the user marketplace, and an old link here opens it.
 * An app every Polaris comes with has no catalog entry, and its page here is
 * drawn from its switcher entry instead.
 */

import { Suspense } from "react";
import { requireAdmin } from "@/lib/session";
import { notFound, redirect } from "next/navigation";
import { isNativeApp } from "@/lib/apps/native-apps";
import { AppInstallState, AppSettingsLink } from "@/app/(app)/apps/marketplace/store-installs";
import { BuiltInAppDetail } from "@/app/(app)/apps/marketplace/[appId]/built-in-detail";
import {
    listingHref,
    storeScope,
    findStoreApp,
    findBuiltInApp
} from "@/lib/apps/marketplace-store";
import {
    AppDetail,
    AppInstallPanelSkeleton
} from "@/app/(app)/apps/marketplace/[appId]/app-detail";

export const dynamic = "force-dynamic";

export default async function PolarisAppPage({ params }: { params: Promise<{ appId: string }> }) {
    const user = await requireAdmin();
    const { appId } = await params;
    const app = findStoreApp(appId);
    if (!app && findBuiltInApp(appId))
        return <BuiltInAppDetail appId={appId} canUpdateApps={user.isAdmin} />;
    if (!app || app.internal) notFound();
    if (isNativeApp(app.id) && app.opensAt) redirect(app.opensAt);
    if (storeScope(app) !== "polaris") redirect(listingHref(app));
    return (
        <AppDetail appId={app.id}>
            <Suspense fallback={null}>
                <AppSettingsLink app={app} user={user} />
            </Suspense>
            <Suspense fallback={<AppInstallPanelSkeleton />}>
                <AppInstallState appId={app.id} user={user} />
            </Suspense>
        </AppDetail>
    );
}
