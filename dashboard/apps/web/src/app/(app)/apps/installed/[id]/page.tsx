/**
 * An installed app's adapted dashboard. The shell (status, lifecycle controls,
 * runtime logs) is shared; app-specific panels mount inside it keyed by the
 * catalog id (e.g. the Messaging bridge's channel panel). Apps without an adapted
 * panel fall back to the shared log view.
 */

import { prisma } from "@polaris/db";
import { notFound } from "next/navigation";
import { requirePermission } from "@/lib/session";
import { getHostLanIp } from "@/lib/host-address";
import { getLocalEnvironment } from "@/lib/network-service";
import { readInstallConfig } from "@/lib/apps/install-config";
import { gameDomainSuffix } from "@/lib/apps/minecraft/address";
import { InstalledAppDashboard } from "./installed-app-dashboard";
import { getInstalledApp, getInstalledAppSettings } from "@/lib/apps/install-service";
import { gamePorts, gameReachAdvice, reachConfirmed, type GameReachAdvice } from "@/lib/apps/minecraft/reach";

export const dynamic = "force-dynamic";

/** Everything a game server's panel needs that only the server can work out. */
export interface GameContext {
    /** What is still in the way of players outside this network. */
    readonly reach: GameReachAdvice;
    /** The name it answers to, when it has one. */
    readonly hostname: string | null;
    /** What every game server's name ends in here, for the address picker. */
    readonly suffix: string | null;
}

/**
 * Worked out here rather than in the panel because none of it changes while the
 * page is open - the machine's environment, its LAN address, the ports the deploy
 * pinned, the domain layout - and the panel polls every five seconds.
 */
async function gameContextFor(app: {
    catalogId: string;
    applicationId: string | null;
    id: string;
}): Promise<GameContext | null> {
    if (!app.catalogId.startsWith("minecraft") || !app.applicationId) return null;
    const [{ environment }, lanIp, ports, install, suffix] = await Promise.all([
        getLocalEnvironment().catch(() => ({ environment: "unknown" as const })),
        getHostLanIp().catch(() => null),
        gamePorts(app.applicationId),
        prisma.installedApp.findUnique({ where: { id: app.id }, select: { config: true } }),
        gameDomainSuffix().catch(() => null)
    ]);
    const config = readInstallConfig(install?.config);
    return {
        reach: gameReachAdvice(environment, ports, reachConfirmed(install?.config), lanIp),
        hostname: typeof config.hostname === "string" ? config.hostname : null,
        suffix
    };
}

export default async function InstalledAppPage({ params }: { params: Promise<{ id: string }> }) {
    const user = await requirePermission("deploy.read");
    const { id } = await params;
    const app = await getInstalledApp(user.id, id);
    if (!app) notFound();
    // What the app was deployed with, so its panel can paint its settings without
    // waiting on a request of its own.
    const [settings, game] = await Promise.all([getInstalledAppSettings(user.id, id), gameContextFor(app)]);
    return <InstalledAppDashboard app={app} settings={settings} game={game} />;
}
