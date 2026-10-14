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
import { notFound } from "next/navigation";
import { findApp } from "@/lib/apps/catalog";
import { uninstallAccess } from "@/lib/apps/install-access";
import { requirePermission, sessionCan, type SessionUser } from "@/lib/session";
import { AppDetail, AppInstallPanel, AppInstallPanelSkeleton } from "./app-detail";
import {
    installForReader,
    instanceWideInstallIds,
    listInstalledApps
} from "@/lib/apps/install-service";

export const dynamic = "force-dynamic";

export default async function MarketplaceAppPage({
    params
}: {
    params: Promise<{ appId: string }>;
}) {
    const user = await requirePermission("deploy.read");
    const { appId } = await params;
    const app = findApp(appId);
    // A helper another app runs is not offered on its own, here or in the grid.
    if (!app || app.internal) notFound();
    return (
        <AppDetail appId={app.id}>
            <Suspense fallback={<AppInstallPanelSkeleton />}>
                <InstallState appId={app.id} user={user} />
            </Suspense>
        </AppDetail>
    );
}

/** Whether this Polaris has the app, and what this reader may do about it. */
async function InstallState({ appId, user }: { appId: string; user: SessionUser }) {
    const [installed, canInstall] = await Promise.all([
        instanceWideInstallIds().then((ids) => listInstalledApps(user.id, ids)),
        sessionCan(user, "deploy.manage")
    ]);
    const installs = await Promise.all(
        installed
            .filter((item) => item.catalogId === appId)
            .map(async (item) => {
                const canUninstall =
                    (await uninstallAccess(user, item.id).catch(() => null)) !== null;
                return { ...installForReader(item, user.id, canUninstall), canUninstall };
            })
    );
    return <AppInstallPanel appId={appId} canInstall={canInstall} installs={installs} />;
}
