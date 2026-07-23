"use server";

/**
 * Marketplace server actions. Browsing needs deploy.read; installing an app
 * provisions a container and so needs deploy.manage. Input is re-validated
 * server-side against the shared install schema.
 */

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/session";
import { listHosts } from "@/lib/host-service";
import { listConnections } from "@/lib/storage-service";
import { recordAudit } from "@/lib/audit-service";
import { installApp, listInstalledApps, type InstalledAppView } from "@/lib/apps/install-service";
import { appInstallInputSchema, type AppInstallInput } from "@/lib/apps/install-schema";

const MARKETPLACE_PATH = "/apps/marketplace";

export interface InstallTarget {
    id: string;
    name: string;
    kind: "local" | "host";
}

export interface StorageConnectionOption {
    id: string;
    name: string;
}

/** Servers an app can be installed on: the local host plus connected SSH hosts. */
export async function listInstallTargetsAction(): Promise<InstallTarget[]> {
    const user = await requirePermission("deploy.manage");
    const hosts = await listHosts(user.id);
    return [
        { id: "local", name: "Local (this server)", kind: "local" },
        ...hosts.map((host) => ({ id: host.id, name: host.name, kind: "host" as const }))
    ];
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
export async function installAppAction(input: AppInstallInput): Promise<{ error?: string; installedAppId?: string }> {
    const user = await requirePermission("deploy.manage");
    const parsed = appInstallInputSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid install request" };
    try {
        const result = await installApp(user.id, user.id, parsed.data);
        await recordAudit({
            actorId: user.id,
            action: "apps.install",
            targetType: "installedApp",
            targetId: result.installedAppId
        });
        revalidatePath(MARKETPLACE_PATH);
        return { installedAppId: result.installedAppId };
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not install the app" };
    }
}
