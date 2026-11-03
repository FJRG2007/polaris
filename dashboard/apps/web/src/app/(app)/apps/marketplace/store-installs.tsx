/**
 * What both marketplaces are handed from the server: the installs that belong
 * to the one being drawn, each with whether this reader may uninstall it, and
 * whether they may install. /apps/marketplace and /admin/apps share it, the
 * grid and an app's own page alike.
 */

import Link from "next/link";
import { Settings } from "lucide-react";
import { findApp } from "@/lib/apps/catalog";
import { isNativeApp } from "@/lib/apps/native-apps";
import { getTranslations } from "@/lib/i18n/request";
import { appSettingsHref } from "@/lib/apps/app-settings";
import type { StoreInstallRow } from "./marketplace-view";
import { AppInstallPanel } from "./[appId]/app-detail";
import { uninstallAccess } from "@/lib/apps/install-access";
import { gameForCatalogId } from "@/lib/apps/games-catalog";
import { sessionCan, type SessionUser } from "@/lib/session";
import { builtInAlternatives, storeScope, type StoreScope } from "@/lib/apps/marketplace-store";
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

/** The installs of one app this reader's marketplace lists, as its cards count them. */
async function appInstalls(user: SessionUser, appId: string) {
    const installed = await instanceWideInstallIds().then((ids) => listInstalledApps(user.id, ids));
    return installed.filter((item) => item.catalogId === appId);
}

/** Whether this reader's marketplace lists the app as installed. */
export async function hasAppInstall(user: SessionUser, appId: string): Promise<boolean> {
    return isNativeApp(appId) || (await appInstalls(user, appId)).length > 0;
}

/** The app's Settings link, offered once it is installed, as its card offers it. */
export async function AppSettingsLink({
    app,
    user
}: {
    app: Parameters<typeof appSettingsHref>[0];
    user: SessionUser;
}) {
    const href = appSettingsHref(app);
    if (!href || !(await hasAppInstall(user, app.id))) return null;
    const t = await getTranslations("marketplace");
    return (
        <Link
            href={href}
            className="text-primary inline-flex w-fit items-center gap-1 text-sm hover:underline"
        >
            <Settings className="size-4" />
            {t("detail.settings")}
        </Link>
    );
}

/** Whether this Polaris has the app, and what this reader may do about it. */
export async function AppInstallState({ appId, user }: { appId: string; user: SessionUser }) {
    const [installed, canInstall, openable] = await Promise.all([
        appInstalls(user, appId),
        sessionCan(user, "deploy.manage"),
        openableBuiltIns(user)
    ]);
    const installs = await Promise.all(installed.map((item) => readerRow(user, item)));
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
 * The addresses of the built-in screens this reader may open, for the note a
 * template carries when one of them already does its job. Asked with
 * `sessionCan`, the same question each screen answers, so the note only links
 * where the link would work.
 */
export async function openableBuiltIns(user: SessionUser): Promise<string[]> {
    const screens = builtInAlternatives();
    const allowed = await Promise.all(
        screens.map((screen) => (screen.permission ? sessionCan(user, screen.permission) : true))
    );
    return screens.filter((_, index) => allowed[index]).map((screen) => screen.href);
}
