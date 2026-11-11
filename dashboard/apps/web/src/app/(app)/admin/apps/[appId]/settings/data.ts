"use server";

import { z } from "zod";
import { requireAdmin } from "@/lib/session";
import { findStoreApp } from "@/lib/apps/marketplace-store";
import { appHasServices, listAppServices } from "@/lib/apps/app-services";
import { hasAppInstall } from "@/app/(app)/apps/marketplace/store-installs";

const appIdSchema = z.string().trim().min(1).max(100);

/**
 * Which screen an app's settings page shows, decided from what is installed:
 * its settings, a move to the app's page while it is not installed, or none
 * at all (null). Settings an app draws among its own routes are drawn here
 * too (`renderAppSettings`), so they never move anywhere else.
 */
export async function loadAppSettingsAction(appId: string) {
    const user = await requireAdmin();
    const app = findStoreApp(appIdSchema.parse(appId));
    if (!app) return null;
    const ownsServices = await appHasServices(app.id);
    if (!app.settingsAt && !ownsServices) return null;
    if (!ownsServices && !(await hasAppInstall(user, app.id)))
        return { screen: "moved" as const, to: `/admin/apps/${encodeURIComponent(app.id)}` };
    return {
        screen: "settings" as const,
        services: ownsServices ? await listAppServices(app.id, user.id) : null
    };
}
