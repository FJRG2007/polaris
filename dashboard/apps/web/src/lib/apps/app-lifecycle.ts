/**
 * What uninstalling and reinstalling a first-party app does beyond its own row.
 *
 * Uninstalling never deletes anybody's data. Two apps need more than the row:
 *
 * - Game servers runs servers, each with a world in it. Taking the app away
 *   while servers exist would either strand them or delete worlds, so it is
 *   refused until they are deleted from the app itself, which is where deleting
 *   one is confirmed.
 * - Places runs helper containers (camera relay, vision, faces). Their
 *   containers come down with the app and their settings and volumes stay, so
 *   reinstalling brings them straight back.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import { POLARIS_APP_CATALOG } from "@/lib/apps/catalog";
import { GAME_SERVERS_APP_ID } from "@/lib/apps/games-catalog";
import { isNativeApp } from "@/lib/apps/native-apps";
import { readerWords } from "@/lib/i18n/reader-words";
import { DNS_BLOCKER_APP, DNS_ENGINE_APP } from "@/lib/dns-blocker/settings";
import { VPN_APP, VPN_ENGINE_APP } from "@/lib/vpn/settings";
import { patchInstallConfig, readInstallConfig } from "@/lib/apps/install-config";
import { deployApplication, removeApplicationDeployment } from "@/lib/deploy-service";

/** Marks a helper container that was brought down by its app being uninstalled. */
const PAUSED_KEY = "pausedWithApp";

/** How many server names a refusal lists before it counts the rest. */
const NAMED = 5;

/** The catalog apps that run on behalf of this one. */
function servicesOf(catalogId: string): string[] {
    return POLARIS_APP_CATALOG.filter((app) => app.ownedBy === catalogId).map((app) => app.id);
}

/**
 * Why this app cannot be uninstalled right now, or null when it can.
 *
 * Game servers is refused while the owner still has servers: they are what the
 * app is for, and removing it must not quietly delete a world.
 */
export async function appUninstallRefusal(row: {
    catalogId: string;
    ownerId: string;
}): Promise<string | null> {
    // Part of Servers on every Polaris: an install row left from when it was a
    // marketplace app is not something to remove.
    if (isNativeApp(row.catalogId)) return (await readerWords("api"))("refusals.apps.native");
    // The network filter answers DNS for every device pointed at it. Taking the app
    // away while its engine runs would leave the engine with no screen to turn it
    // off from - or, paused with the app, the whole network without names.
    if (row.catalogId === DNS_BLOCKER_APP) {
        const engine = await prisma.installedApp.findFirst({
            where: { catalogId: DNS_ENGINE_APP, status: { not: "removed" } },
            select: { id: true }
        });
        return engine ? (await readerWords("api"))("refusals.apps.dnsBlockerRunning") : null;
    }
    // The VPN's control server holds every device's sign-in, kept across Turn
    // off on purpose. Deleting it is the Remove on the VPN's own screen, which
    // says so; uninstalling the screens must not do it on the way past.
    if (row.catalogId === VPN_APP) {
        const engine = await prisma.installedApp.findFirst({
            where: { catalogId: VPN_ENGINE_APP, status: { not: "removed" } },
            select: { id: true }
        });
        return engine ? (await readerWords("api"))("refusals.apps.vpnKept") : null;
    }
    if (row.catalogId !== GAME_SERVERS_APP_ID) return null;
    const servers = await prisma.installedApp.findMany({
        where: {
            ownerId: row.ownerId,
            catalogId: { in: servicesOf(GAME_SERVERS_APP_ID) },
            status: { not: "removed" }
        },
        select: { name: true },
        orderBy: { createdAt: "asc" }
    });
    if (servers.length === 0) return null;
    const named = servers.slice(0, NAMED).map((server) => server.name);
    const more = servers.length - named.length;
    const list = more > 0 ? `${named.join(", ")} and ${more} more` : named.join(", ");
    return `Delete your game servers first (${list}). Uninstalling Game servers never deletes a world.`;
}

/**
 * Bring down the helper containers an app runs, keeping their settings and data.
 *
 * Game servers are not helpers and are never touched here - see
 * `appUninstallRefusal`.
 */
export async function pauseOwnedServices(catalogId: string): Promise<void> {
    if (catalogId === GAME_SERVERS_APP_ID) return;
    const services = servicesOf(catalogId);
    if (services.length === 0) return;
    const installs = await prisma.installedApp.findMany({
        where: {
            catalogId: { in: services },
            status: { not: "removed" },
            applicationId: { not: null }
        },
        select: { id: true, ownerId: true, catalogId: true, applicationId: true }
    });
    for (const install of installs) {
        const applicationId = install.applicationId as string;
        const application = await prisma.application.findFirst({
            where: { id: applicationId },
            select: { desiredState: true }
        });
        try {
            await removeApplicationDeployment(applicationId, install.ownerId);
            if (application?.desiredState === "running") {
                await patchInstallConfig(install.id, { [PAUSED_KEY]: true });
            }
        } catch (error) {
            console.error(`polaris: could not bring down ${install.catalogId}:`, error);
        }
    }
}

/** Bring back the helper containers `pauseOwnedServices` brought down. */
export async function resumeOwnedServices(
    catalogId: string,
    actorId: string | null
): Promise<void> {
    const services = servicesOf(catalogId);
    if (services.length === 0 || catalogId === GAME_SERVERS_APP_ID) return;
    const installs = await prisma.installedApp.findMany({
        where: {
            catalogId: { in: services },
            status: { not: "removed" },
            applicationId: { not: null }
        },
        select: { id: true, ownerId: true, catalogId: true, applicationId: true, config: true }
    });
    for (const install of installs) {
        if (!install.applicationId || readInstallConfig(install.config)[PAUSED_KEY] !== true)
            continue;
        const application = await prisma.application.findFirst({
            where: { id: install.applicationId },
            select: { desiredState: true }
        });
        try {
            if (application?.desiredState === "running") {
                await deployApplication(install.applicationId, install.ownerId, actorId);
            }
            await patchInstallConfig(install.id, { [PAUSED_KEY]: false });
        } catch (error) {
            console.error(`polaris: could not bring back ${install.catalogId}:`, error);
        }
    }
}
