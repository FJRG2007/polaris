/**
 * One Polaris app's page: the same store page as /apps/marketplace/<id>, on the
 * admin screen that lists it. Admin-only, like the grid. Another developer's
 * app has its page in the user marketplace, and an old link here opens it.
 */

import { Suspense } from "react";
import { findApp } from "@/lib/apps/catalog";
import { requireAdmin } from "@/lib/session";
import { notFound, redirect } from "next/navigation";
import { isNativeApp } from "@/lib/apps/native-apps";
import { listingHref, storeScope } from "@/lib/apps/marketplace-store";
import { AppInstallState } from "@/app/(app)/apps/marketplace/store-installs";
import {
    AppDetail,
    AppInstallPanelSkeleton
} from "@/app/(app)/apps/marketplace/[appId]/app-detail";

export const dynamic = "force-dynamic";

export default async function PolarisAppPage({ params }: { params: Promise<{ appId: string }> }) {
    const user = await requireAdmin();
    const { appId } = await params;
    const app = findApp(appId);
    if (!app || app.internal) notFound();
    if (isNativeApp(app.id) && app.opensAt) redirect(app.opensAt);
    if (storeScope(app) !== "polaris") redirect(listingHref(app));
    return (
        <AppDetail appId={app.id}>
            <Suspense fallback={<AppInstallPanelSkeleton />}>
                <AppInstallState appId={app.id} user={user} />
            </Suspense>
        </AppDetail>
    );
}
