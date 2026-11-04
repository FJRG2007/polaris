"use server";

/**
 * Marketplace server actions. Browsing needs deploy.read; installing an app
 * provisions a container and so needs deploy.manage, and a Polaris app is
 * instance-wide, so installing one also needs the admin flag. Input is
 * re-validated server-side against the shared install schema.
 */

import { revalidatePath } from "next/cache";
import { requireAdmin, requirePermission } from "@/lib/session";
import { listConnections } from "@/lib/storage-service";
import { recordAudit } from "@/lib/audit-service";
import { installApp, listInstalledApps, type InstalledAppView } from "@/lib/apps/install-service";
import {
    appInstallInputSchema,
    NAS_CONNECTION_REQUIRED,
    type AppInstallInput
} from "@/lib/apps/install-schema";
import { getTranslations } from "@/lib/i18n/request";
import { findStoreApp, storeScope } from "@/lib/apps/marketplace-store";
import { validationMessage } from "@/components/i18n/validation-message";

const MARKETPLACE_PATH = "/apps/marketplace";
const POLARIS_APPS_PATH = "/admin/apps";

export interface StorageConnectionOption {
    id: string;
    name: string;
}

/** NAS/storage connections a volume can be backed by. */
export async function listStorageConnectionsAction(): Promise<StorageConnectionOption[]> {
    const user = await requirePermission("deploy.manage");
    const connections = await listConnections(user.id);
    return connections.map((connection) => ({ id: connection.id, name: connection.name }));
}

/** The owner's installed apps. */
export async function listInstalledAppsAction(): Promise<InstalledAppView[]> {
    const user = await requirePermission("deploy.read");
    return listInstalledApps(user.id);
}

/** Install a catalog app onto the chosen server with the chosen storage. */
export async function installAppAction(
    input: AppInstallInput
): Promise<{ error?: string; installedAppId?: string }> {
    const user = await requirePermission("deploy.manage");
    const parsed = appInstallInputSchema.safeParse(input);
    if (!parsed.success) {
        const t = await getTranslations("marketplace");
        const message = parsed.error.issues[0]?.message;
        if (!message) return { error: t("errors.invalid") };
        return {
            error:
                message === NAS_CONNECTION_REQUIRED
                    ? t("errors.chooseNas")
                    : validationMessage(await getTranslations("validation"), message)
        };
    }
    const manifest = findStoreApp(parsed.data.catalogId);
    if (manifest && storeScope(manifest) === "polaris") await requireAdmin();
    try {
        const result = await installApp(user.id, user.id, parsed.data);
        await recordAudit({
            actorId: user.id,
            action: "apps.install",
            targetType: "installedApp",
            targetId: result.installedAppId
        });
        revalidatePath(MARKETPLACE_PATH);
        revalidatePath(POLARIS_APPS_PATH);
        return { installedAppId: result.installedAppId };
    } catch (caught) {
        return {
            error:
                caught instanceof Error
                    ? caught.message
                    : (await getTranslations("marketplace"))("errors.install")
        };
    }
}
