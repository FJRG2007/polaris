"use server";

/**
 * Lifecycle actions for one installed app, delegating to the same Deploy
 * primitives as the Deploy pillar.
 *
 * Each is resolved against the install itself rather than against a global grant,
 * so somebody given `deploy.manage` on one app can restart that one and no other.
 * Uninstalling is deliberately not among them: it is the owner's, because taking
 * an app away is not something "manage this app" should ever have handed out.
 */

import { revalidatePath } from "next/cache";
import { recordAudit } from "@/lib/audit-service";
import { clearResourceGrants } from "@polaris/auth";
import { installRef } from "@/lib/apps/install-access";
import { flushGameWorld } from "@/lib/apps/games-flush";
import { clearCrashLoop } from "@/lib/apps/games-health";
import { getInstalledApp, uninstallApp } from "@/lib/apps/install-service";
import { deployApplication, setApplicationRunning } from "@/lib/deploy-service";
import { requirePermissionOn, type ResourceAccess } from "@/lib/resource-access";

/** The backing application, resolved on the owner's behalf. */
async function applicationFor(access: ResourceAccess, id: string): Promise<string> {
    const app = await getInstalledApp(access.ownerId, id);
    if (!app) throw new Error("Installed app not found");
    if (!app.applicationId) throw new Error("This app has no deployment yet");
    return app.applicationId;
}

export async function redeployInstalledAppAction(id: string): Promise<{ error?: string }> {
    try {
        const { user, access } = await requirePermissionOn("deploy.manage", installRef(id));
        const applicationId = await applicationFor(access, id);
        // A game server's world lives in memory between autosaves, and a redeploy
        // destroys the container. Anything that is not a game server has nothing to
        // flush and this costs it one query.
        await flushGameWorld(access.ownerId, id);
        await deployApplication(applicationId, access.ownerId, user.id);
        revalidatePath(`/apps/installed/${id}`);
        return {};
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not redeploy" };
    }
}

export async function setInstalledAppRunningAction(id: string, running: boolean): Promise<{ error?: string }> {
    try {
        const { access } = await requirePermissionOn("deploy.manage", installRef(id));
        const applicationId = await applicationFor(access, id);
        if (!running) await flushGameWorld(access.ownerId, id);
        // Starting it again is somebody saying the crash it was stopped for has
        // been dealt with. If it has not, the health sweep says so within a minute.
        if (running) await clearCrashLoop(id);
        await setApplicationRunning(applicationId, access.ownerId, running);
        revalidatePath(`/apps/installed/${id}`);
        return {};
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not update the app" };
    }
}

export async function uninstallInstalledAppAction(id: string): Promise<{ error?: string }> {
    try {
        const { user, access } = await requirePermissionOn("deploy.manage", installRef(id));
        if (!access.isOwner && !user.isAdmin) {
            return { error: "Only the person who installed this app can remove it" };
        }
        await uninstallApp(access.ownerId, id);
        // The app is gone, so the access people were given to it is too.
        await clearResourceGrants(installRef(id));
        await recordAudit({ actorId: user.id, action: "apps.uninstall", targetType: "installedApp", targetId: id });
        revalidatePath("/apps/marketplace");
        return {};
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not uninstall the app" };
    }
}
