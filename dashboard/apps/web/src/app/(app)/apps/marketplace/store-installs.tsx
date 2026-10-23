/**
 * What both marketplaces are handed from the server: the installs that belong
 * to the one being drawn, each with whether this reader may uninstall it, and
 * whether they may install. /apps/marketplace and /admin/apps share it, the
 * grid and an app's own page alike.
 */

import { findApp } from "@/lib/apps/catalog";
import type { StoreInstallRow } from "./marketplace-view";
import { AppInstallPanel } from "./[appId]/app-detail";
import { uninstallAccess } from "@/lib/apps/install-access";
import { gameForCatalogId } from "@/lib/apps/games-catalog";
import { sessionCan, type SessionUser } from "@/lib/session";
import { builtInApps, storeScope, type StoreScope } from "@/lib/apps/marketplace-store";
import {
    installForReader,
    instanceWideInstallIds,
    listInstalledApps
} from "@/lib/apps/install-service";

/** One install as this reader is shown it, with whether they may remove it. */
async function readerRow(
    user: SessionUser,
    item: Awaited<ReturnType<typeof listInstalledApps>>[number]
) {
    // Somebody else's install is cut to what this reader may be sent. Whether
    // they may uninstall it is the uninstall action's own check, so Uninstall is
    // offered exactly where it would work.
    const canUninstall = (await uninstallAccess(user, item.id).catch(() => null)) !== null;
    return { ...installForReader(item, user.id, canUninstall), canUninstall };
}

export async function storeInstalls(
    user: SessionUser,
    scope: StoreScope
): Promise<{ installed: StoreInstallRow[]; canInstall: boolean }> {
    const installed = (await listInstalledApps(user.id, await instanceWideInstallIds())).filter(
        (item) => {
            const manifest = findApp(item.catalogId);
            // An install whose manifest is gone stays where anybody who can deploy finds it.
            return manifest ? storeScope(manifest) === scope : scope === "deployable";
        }
    );
    const [canInstall, shown] = await Promise.all([
        sessionCan(user, "deploy.manage"),
        Promise.all(
            installed
                .filter((item) => gameForCatalogId(item.catalogId) === undefined)
                .map((item) => readerRow(user, item))
        )
    ]);
    return { installed: shown, canInstall };
}

/** Whether this Polaris has the app, and what this reader may do about it. */
export async function AppInstallState({ appId, user }: { appId: string; user: SessionUser }) {
    const [installed, canInstall, openable] = await Promise.all([
        instanceWideInstallIds().then((ids) => listInstalledApps(user.id, ids)),
        sessionCan(user, "deploy.manage"),
        openableBuiltIns(user)
    ]);
    const installs = await Promise.all(
        installed.filter((item) => item.catalogId === appId).map((item) => readerRow(user, item))
    );
    return (
        <AppInstallPanel
            appId={appId}
            canInstall={canInstall}
            installs={installs}
            openableBuiltIns={openable}
        />
    );
}

/**
 * The built-in apps this reader may open, for the note a template carries when
 * one of them already does its job. Asked with `sessionCan`, the same question
 * each app's pages answer, so the note only links where the link would work.
 */
export async function openableBuiltIns(user: SessionUser): Promise<string[]> {
    const entries = builtInApps();
    const allowed = await Promise.all(
        entries.map((entry) => (entry.permission ? sessionCan(user, entry.permission) : true))
    );
    return entries.filter((_, index) => allowed[index]).map((entry) => entry.id);
}
