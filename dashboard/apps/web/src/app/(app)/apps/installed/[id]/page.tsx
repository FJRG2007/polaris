/**
 * An installed app's adapted dashboard. The shell (status, lifecycle controls,
 * runtime logs) is shared; app-specific panels mount inside it keyed by the
 * catalog id (e.g. the Messaging bridge's channel panel). Apps without an adapted
 * panel fall back to the shared log view.
 */

import { prisma } from "@polaris/db";
import { notFound } from "next/navigation";
import { requirePermission } from "@/lib/session";
import { reachAdviceFor } from "@/lib/apps/minecraft/reach";
import { readInstallConfig } from "@/lib/apps/install-config";
import { gameDomainSuffix } from "@/lib/apps/minecraft/address";
import { InstalledAppDashboard } from "./installed-app-dashboard";
import type { GameReachAdvice } from "@/lib/apps/minecraft/reach-advice";
import { getInstalledApp, getInstalledAppSettings } from "@/lib/apps/install-service";

export const dynamic = "force-dynamic";

/** Everything a game server's panel needs that only the server can work out. */
export interface GameContext {
    /** What is still in the way of players outside this network. */
    readonly reach: GameReachAdvice;
    /** The name it answers to, when it has one. */
    readonly hostname: string | null;
    /** What every game server's name ends in here, for the address picker. */
    readonly suffix: string | null;
    /** When an icon was last uploaded, so the panel can say there is one without
     *  reaching into the container to look. */
    readonly iconSetAt: string | null;
}

/**
 * Worked out here so the panel paints with it rather than after it - the machine's
 * environment, the ports the deploy pinned, the domain layout. The reach is the
 * one part that can change while the page is open, so this is only its starting
 * point: it is read without knocking on anything, and the panel's own poll takes
 * it from there.
 */
async function gameContextFor(app: {
    catalogId: string;
    applicationId: string | null;
    id: string;
}): Promise<GameContext | null> {
    if (!app.catalogId.startsWith("minecraft") || !app.applicationId) return null;
    const [reach, install, suffix] = await Promise.all([
        reachAdviceFor(app.id),
        prisma.installedApp.findUnique({ where: { id: app.id }, select: { config: true } }),
        gameDomainSuffix().catch(() => null)
    ]);
    const config = readInstallConfig(install?.config);
    return {
        reach,
        hostname: typeof config.hostname === "string" ? config.hostname : null,
        suffix,
        iconSetAt: typeof config.iconSetAt === "string" ? config.iconSetAt : null
    };
}

export default async function InstalledAppPage({ params }: { params: Promise<{ id: string }> }) {
    const user = await requirePermission("deploy.read");
    const { id } = await params;
    const app = await getInstalledApp(user.id, id);
    if (!app) notFound();
    // What the app was deployed with, so its panel can paint its settings without
    // waiting on a request of its own. Both are detail on a page whose job is to
    // manage the install, so neither may take it down: an app that cannot be
    // described is precisely the one somebody came here to stop or remove.
    const [settings, game] = await Promise.all([
        getInstalledAppSettings(user.id, id),
        gameContextFor(app).catch(() => null)
    ]);
    return <InstalledAppDashboard app={app} settings={settings} game={game} />;
}
