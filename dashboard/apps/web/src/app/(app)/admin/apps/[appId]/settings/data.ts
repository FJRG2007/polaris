"use server";

import { z } from "zod";
import { requireAdmin } from "@/lib/session";
import { appSettingsPath } from "@/lib/apps/app-settings";
import { findStoreApp } from "@/lib/apps/marketplace-store";
import { appHasServices, listAppServices } from "@/lib/apps/app-services";
import { hasAppInstall } from "@/app/(app)/apps/marketplace/store-installs";

const appIdSchema = z.string().trim().min(1).max(100);

/**
 * Which screen an app's settings page shows, decided from what is installed:
 * its settings, a move to where they are drawn, or none at all (null).
 */
export async function loadAppSettingsAction(appId: string) {
    const user = await requireAdmin();
    const app = findStoreApp(appIdSchema.parse(appId));
    if (!app) return null;
    const ownsServices = await appHasServices(app.id);
    if (!app.settingsAt && !ownsServices) return null;
    if (!ownsServices && !(await hasAppInstall(user, app.id)))
        return { screen: "moved" as const, to: `/admin/apps/${encodeURIComponent(app.id)}` };
    const drawnElsewhere =
        app.settingsAt && app.settingsAt !== appSettingsPath(app.id) ? app.settingsAt : null;
    if (drawnElsewhere && !ownsServices) return { screen: "moved" as const, to: drawnElsewhere };
    if (!ownsServices && app.id !== "vpn") return null;
    return {
        screen: "settings" as const,
        drawnElsewhere,
        services: ownsServices ? await listAppServices(app.id, user.id) : null
    };
}
