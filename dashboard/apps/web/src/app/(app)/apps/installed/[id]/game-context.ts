/**
 * What a game server's panel needs that only the server side can work out.
 *
 * Its own module rather than the route's, because both the route and the client
 * panel refer to it: a type exported from a page is fine until the page moves,
 * and this one is imported from three places.
 *
 * Everything here is a database read. Nothing knocks on a port, opens a socket or
 * runs a command in a container - the panel paints from this and then fills the
 * live parts in from its own poll. It used to work out the port advice here too,
 * which meant every visit to a server's page sat on up to three UDP probes before
 * a single pixel appeared, for a warning nobody was waiting on.
 */

import { prisma } from "@polaris/db";
import { BLUEPRINT_KEY } from "@/lib/apps/games-create";
import { gameServerFacts } from "@/lib/apps/games-service";
import type { ArkAccessView } from "@/lib/apps/ark/service";
import { readInstallConfig } from "@/lib/apps/install-config";
import { gameDomainSuffix } from "@/lib/apps/minecraft/address";
import { readArkAccess, readArkPorts } from "@/lib/apps/ark/service";
import { listPlayerAccess } from "@/lib/apps/minecraft/player-access";
import { gameOfServer, routesByHostname } from "@/lib/apps/games-catalog";
import type { PlayerAccessView } from "@/lib/apps/minecraft/player-access";
import { editionOf, type MinecraftEdition } from "@/lib/apps/minecraft/service";
import { readSchedule, readScheduleState, type GameSchedule, type ScheduleState } from "@/lib/apps/minecraft/schedule";

export interface GameContext {
    /** The name it answers to, when it has one. */
    readonly hostname: string | null;
    /** What every game server's name ends in here, for the address picker. */
    readonly suffix: string | null;
    /** What a player types to connect, as far as Polaris' own records go. */
    readonly address: string | null;
    /** Whether it answers on the shared port, behind the hostname router, rather
     *  than on a port of its own. */
    readonly routed: boolean;
    /** Whether it could be: only a client that puts the address in its handshake
     *  can be routed by it, which is Minecraft: Java and nothing else here. */
    readonly canRoute: boolean;
    /** When an icon was last uploaded, so the panel can say there is one without
     *  reaching into the container to look. */
    readonly iconSetAt: string | null;
    /** Which Minecraft this is, and null for a game that has no editions. The
     *  screens that offer a world type or carry player data need it, and asking
     *  the container for it would make them wait on a server that may be off. */
    readonly edition: MinecraftEdition | null;
    /** The blueprint it was built from, when it was built from one. Null for a
     *  server created before blueprints were recorded, which is the same thing
     *  the screens say about one built as plain survival. */
    readonly blueprintId: string | null;
    /** The hours it is kept up, and the hours it may go quiet. */
    readonly schedule: GameSchedule;
    /** What the last sweep of that schedule saw. */
    readonly scheduleState: ScheduleState;
    /**
     * Who this server is meant to let in, in whichever shape its game keeps that.
     *
     * Here rather than behind the panel's poll because both are things Polaris
     * wrote down itself, while the poll they used to arrive on runs a command
     * inside the container - so the whole players table sat empty for as long as
     * the server took to answer, including forever for one that never does.
     */
    readonly arkAccess: ArkAccessView | null;
    readonly playerAccess: PlayerAccessView | null;
    /**
     * The two ports an ARK server is joined on, and null for a game with one.
     *
     * Facts about the deploy rather than anything the server has to be asked, so
     * the card that tells somebody what to paste into Steam can print it at once.
     * The one that needs the query port was blank until the container answered,
     * which on a server that was still loading meant the address nobody could
     * work out by themselves was the last thing to appear.
     */
    readonly gamePort: number | null;
    readonly queryPort: number | null;
}

/**
 * Worked out here so the panel paints with it rather than after it - the domain
 * layout, the ports the deploy pinned, the lists Polaris keeps itself.
 */
export async function gameContextFor(app: {
    catalogId: string;
    applicationId: string | null;
    id: string;
    ownerId?: string;
}): Promise<GameContext | null> {
    const game = gameOfServer(app.catalogId);
    if (!game || !app.applicationId) return null;
    const install = await prisma.installedApp.findUnique({
        where: { id: app.id },
        select: { config: true, ownerId: true }
    });
    const ownerId = app.ownerId ?? install?.ownerId ?? null;
    const [suffix, facts, arkAccess, playerAccess, ports] = await Promise.all([
        // Each game's servers live under a label of their own, so the address
        // picker has to be told which one it is naming a server in.
        gameDomainSuffix(game.domainLabel).catch(() => null),
        ownerId ? gameServerFacts(ownerId, app.id).catch(() => null) : null,
        game.id === "ark" && ownerId ? readArkAccess(ownerId, app.id).catch(() => null) : null,
        game.id === "minecraft" && ownerId ? listPlayerAccess(ownerId, app.id).catch(() => null) : null,
        game.id === "ark" ? readArkPorts(app.applicationId).catch(() => null) : null
    ]);
    const config = readInstallConfig(install?.config);
    return {
        hostname: typeof config.hostname === "string" ? config.hostname : null,
        suffix,
        address: facts?.address ?? null,
        routed: config.routed === true,
        canRoute: routesByHostname(app.catalogId),
        iconSetAt: typeof config.iconSetAt === "string" ? config.iconSetAt : null,
        edition: game.id === "minecraft" ? editionOf(app.catalogId) : null,
        blueprintId: typeof config[BLUEPRINT_KEY] === "string" ? (config[BLUEPRINT_KEY] as string) : null,
        schedule: readSchedule(config),
        scheduleState: readScheduleState(config),
        arkAccess,
        playerAccess,
        gamePort: ports?.gamePort ?? null,
        queryPort: ports?.queryPort ?? null
    };
}
