"use server";

/**
 * Lifecycle actions for one installed app, delegating to the same Deploy
 * primitives as the Deploy pillar. Reads need deploy.read; mutations need
 * deploy.manage and are re-checked server-side.
 */

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/session";
import { deployApplication, setApplicationRunning } from "@/lib/deploy-service";
import { getInstalledApp, uninstallApp } from "@/lib/apps/install-service";
import { recordAudit } from "@/lib/audit-service";

/** The backing application id, asserting the caller owns the install. */
async function ownedApplicationId(id: string, ownerId: string): Promise<string> {
    const app = await getInstalledApp(ownerId, id);
    if (!app) throw new Error("Installed app not found");
    if (!app.applicationId) throw new Error("This app has no deployment yet");
    return app.applicationId;
}

export async function redeployInstalledAppAction(id: string): Promise<{ error?: string }> {
    const user = await requirePermission("deploy.manage");
    try {
        const applicationId = await ownedApplicationId(id, user.id);
        await deployApplication(applicationId, user.id, user.id);
        revalidatePath(`/apps/installed/${id}`);
        return {};
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not redeploy" };
    }
}

export async function setInstalledAppRunningAction(id: string, running: boolean): Promise<{ error?: string }> {
    const user = await requirePermission("deploy.manage");
    try {
        const applicationId = await ownedApplicationId(id, user.id);
        await setApplicationRunning(applicationId, user.id, running);
        revalidatePath(`/apps/installed/${id}`);
        return {};
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not update the app" };
    }
}

export async function uninstallInstalledAppAction(id: string): Promise<{ error?: string }> {
    const user = await requirePermission("deploy.manage");
    try {
        await uninstallApp(user.id, id);
        await recordAudit({ actorId: user.id, action: "apps.uninstall", targetType: "installedApp", targetId: id });
        revalidatePath("/apps/marketplace");
        return {};
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not uninstall the app" };
    }
}
