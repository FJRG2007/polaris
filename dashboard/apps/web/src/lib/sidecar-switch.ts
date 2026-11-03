/**
 * Turn off the Polaris feature that started a sidecar, from a screen that only
 * knows the container (the security scans' image list).
 *
 * Nothing here stops a container itself. Each feature already has the action its
 * own screen calls to switch it off - which checks who is asking, records it and
 * takes the container down - and this only finds that action and calls it, so a
 * feature turned off from here is in exactly the state its own switch leaves it.
 *
 * Server-only.
 */

import { sidecarOf, type SidecarFeature } from "@polaris/deploy";
import { appProjectIds } from "@/lib/deploy/uninstall-leftovers";

const APP_TUNNELS: ReadonlySet<SidecarFeature> = new Set([
    "app-tunnel-named",
    "app-tunnel-quick",
    "app-tunnel-ngrok"
]);

/** The projects, of those given, whose feature the person asking may turn off -
 *  the same checks each feature's own switch makes: an administrator for the
 *  account, share and backup tunnels, `deploy.manage` and the service's domains
 *  for a service's tunnel. */
export async function turnOffAllowed(
    sidecars: readonly { feature: SidecarFeature; project: string }[]
): Promise<string[]> {
    if (sidecars.length === 0) return [];
    const { requireUser, sessionCan } = await import("@/lib/session");
    const user = await requireUser();
    const services = sidecars.some((one) => APP_TUNNELS.has(one.feature))
        ? await appProjectIds()
        : null;
    const deploys = services ? await sessionCan(user, "deploy.manage") : false;
    const { requireApplicationAccess } = await import("@/lib/deploy-project-access");
    const allowed: string[] = [];
    for (const one of sidecars) {
        const sidecar = sidecarOf(one.project, one.feature === "tunnel-ngrok" ? "ngrok/ngrok" : "");
        if (!sidecar || sidecar.feature !== one.feature) continue;
        if (!APP_TUNNELS.has(sidecar.feature)) {
            if (user.isAdmin) allowed.push(one.project);
            continue;
        }
        const appId = sidecar.appProject ? services?.get(sidecar.appProject) : undefined;
        if (!deploys || !appId) continue;
        const reaches = await requireApplicationAccess(appId, user.id, "domains.manage").then(
            () => true,
            () => false
        );
        if (reaches) allowed.push(one.project);
    }
    return allowed;
}

/** The features this can turn off, and the project each one has to match. */
export async function turnOffSidecar(
    feature: SidecarFeature,
    project: string
): Promise<{ ok: boolean }> {
    const sidecar = sidecarOf(project, feature === "tunnel-ngrok" ? "ngrok/ngrok" : "");
    if (!sidecar || sidecar.feature !== feature) return { ok: false };

    switch (feature) {
        case "tunnel-ngrok":
        case "tunnel-cloudflare": {
            const { saveTunnelAction } = await import("@/app/(app)/admin/integrations/actions");
            const provider = feature === "tunnel-ngrok" ? "ngrok" : "cloudflare";
            const result = await saveTunnelAction({ provider, enabled: false });
            return { ok: !result.error };
        }
        case "share-tunnel": {
            const { getPolarisPublicUrl } = await import("@/lib/polaris-tunnel-service");
            const { removeAddressAction } = await import("@/app/(app)/admin/domains/actions");
            const url = await getPolarisPublicUrl();
            if (!url) return { ok: false };
            const result = await removeAddressAction(new URL(url).hostname);
            return { ok: !result.error };
        }
        case "backup-tunnel": {
            const { readConfig } = await import("@/lib/backup-access/service");
            const { saveBackupAccessAction } = await import("@/app/(app)/admin/domains/actions");
            await saveBackupAccessAction({ ...(await readConfig()), path: null });
            return { ok: true };
        }
        default: {
            const appId = await serviceOf(sidecar.appProject);
            if (!appId) return { ok: false };
            const actions = await import("@/app/(app)/apps/deploy/actions");
            const stop =
                feature === "app-tunnel-named"
                    ? actions.stopNamedTunnelAction
                    : feature === "app-tunnel-quick"
                      ? actions.stopQuickTunnelAction
                      : actions.stopNgrokTunnelAction;
            const result = await stop(appId);
            return { ok: !result.error };
        }
    }
}

/** The service a tunnel's project names, by its hashed id. */
async function serviceOf(appProject: string | undefined): Promise<string | null> {
    if (!appProject) return null;
    return (await appProjectIds())?.get(appProject) ?? null;
}
