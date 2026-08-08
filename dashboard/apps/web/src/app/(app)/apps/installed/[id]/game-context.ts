/**
 * What a game server's panel needs that only the server side can work out.
 *
 * Its own module rather than the route's, because both the route and the client
 * panel refer to it: a type exported from a page is fine until the page moves,
 * and this one is imported from three places.
 */

import { prisma } from "@polaris/db";
import { reachAdviceFor } from "@/lib/apps/minecraft/reach";
import { readInstallConfig } from "@/lib/apps/install-config";
import { gameDomainSuffix } from "@/lib/apps/minecraft/address";
import { readSchedule, type GameSchedule } from "@/lib/apps/minecraft/schedule";
import type { GameReachAdvice } from "@/lib/apps/minecraft/reach-advice";

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
    /** The hours it is kept up, and the hours it may go quiet. */
    readonly schedule: GameSchedule;
}

/**
 * Worked out here so the panel paints with it rather than after it - the machine's
 * environment, the ports the deploy pinned, the domain layout. The reach is the
 * one part that can change while the page is open, so this is only its starting
 * point: it is read without knocking on anything, and the panel's own poll takes
 * it from there.
 */
export async function gameContextFor(app: {
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
        iconSetAt: typeof config.iconSetAt === "string" ? config.iconSetAt : null,
        schedule: readSchedule(config)
    };
}
