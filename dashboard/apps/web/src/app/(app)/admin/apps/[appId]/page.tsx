/**
 * One Polaris app's page: the same store page as /apps/marketplace/<id>, on the
 * admin screen that lists it. Admin-only, like the grid. Another developer's
 * app has its page in the user marketplace, and an old link here opens it.
 */

import Link from "next/link";
import { Suspense } from "react";
import { Settings } from "lucide-react";
import { APPS_WITH_SETTINGS } from "@/lib/apps/app-settings";
import { requireAdmin } from "@/lib/session";
import { notFound, redirect } from "next/navigation";
import { isNativeApp } from "@/lib/apps/native-apps";
import { getTranslations } from "@/lib/i18n/request";
import { AppInstallState } from "@/app/(app)/apps/marketplace/store-installs";
import { listingHref, storeScope, findStoreApp } from "@/lib/apps/marketplace-store";
import {
    AppDetail,
    AppInstallPanelSkeleton
} from "@/app/(app)/apps/marketplace/[appId]/app-detail";

export const dynamic = "force-dynamic";

export default async function PolarisAppPage({ params }: { params: Promise<{ appId: string }> }) {
    const user = await requireAdmin();
    const { appId } = await params;
    const app = findStoreApp(appId);
    if (!app || app.internal) notFound();
    if (isNativeApp(app.id) && app.opensAt) redirect(app.opensAt);
    if (storeScope(app) !== "polaris") redirect(listingHref(app));
    const t = await getTranslations("marketplace");
    return (
        <AppDetail appId={app.id}>
            {APPS_WITH_SETTINGS.includes(app.id) ? (
                <Link
                    href={`/admin/apps/${app.id}/settings`}
                    className="text-primary inline-flex w-fit items-center gap-1 text-sm hover:underline"
                >
                    <Settings className="size-4" />
                    {t("detail.settings")}
                </Link>
            ) : null}
            <Suspense fallback={<AppInstallPanelSkeleton />}>
                <AppInstallState appId={app.id} user={user} />
            </Suspense>
        </AppDetail>
    );
}
