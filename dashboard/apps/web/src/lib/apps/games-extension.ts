/**
 * Game servers, as core sees it: the one object that answers every question the
 * dashboard asks of this app.
 *
 * Core never imports Game servers' modules; it asks the app extension registry,
 * and this is what is registered there. Everything the app does for a core
 * screen, a core job or a core pass is reached through here.
 */

import { isGameServerApp } from "@/lib/apps/catalog";
import type { AppExtension } from "@/lib/app-extensions/types";
import type { BackupSource } from "@/lib/backups/sources/types";
import { gameJobTable } from "@/lib/apps/games-jobs";
import { SOFTWARE_KEY } from "@/lib/apps/minecraft/join-guard";
import { minecraftImageFor } from "@/lib/apps/minecraft/runtime";
import { isPluginLoader, loaderForType } from "@/lib/apps/minecraft/modrinth";
import { GAME_SERVERS_APP_ID, gameOfServer, isGameManagerApp } from "@/lib/apps/games-catalog";

// Everything heavier is imported where it is used. This module is loaded with
// core's registry, so what it imports at the top is loaded by every core module
// that asks the registry anything - and the services behind a game server reach
// the database, the session and the container runtime.
const games = () => import("@/lib/apps/games-service");

/** The slot kinds this app draws, which its client registry renders. */
export const GAME_SLOTS = {
    firewall: "firewall",
    home: "app-home",
    server: "server"
} as const;

/** The job table, whose bodies load their own modules when they run. */
function gameServerJobs() {
    return gameJobTable();
}

/**
 * The world backup source, loaded when the backup engine first uses it.
 *
 * Every method forwards to the real source, so the engine never waits on it
 * until a world is actually being copied.
 */
const worldSource = () =>
    import("@/lib/backups/sources/minecraft").then((module) => module.minecraftWorldSource);
const lazyWorldSource: BackupSource = {
    kind: "minecraft-world",
    discover: async (ownerId) => (await worldSource()).discover(ownerId),
    resolveName: async (resource) => (await worldSource()).resolveName(resource),
    produce: async (resource) => (await worldSource()).produce(resource),
    produceInPlace: async (resource) => (await worldSource()).produceInPlace?.(resource) ?? null,
    readInPlace: async (resource, path) => {
        const source = await worldSource();
        if (!source.readInPlace) throw new Error("This copy cannot be read back");
        return source.readInPlace(resource, path);
    },
    removeInPlace: async (resource, path) => (await worldSource()).removeInPlace?.(resource, path),
    restore: async (resource, body, metadata, actorId) => {
        const source = await worldSource();
        if (!source.restore) throw new Error("This copy cannot be put back");
        return source.restore(resource, body, metadata, actorId);
    }
};

export const gameServersExtension: AppExtension = {
    id: GAME_SERVERS_APP_ID,

    jobs: () => gameServerJobs(),

    backupSources: () => ({ "minecraft-world": lazyWorldSource }),

    // A Minecraft server runs the Java its release needs, which changes with the
    // release it is set to.
    releaseImage: minecraftImageFor,

    pluginServer: (catalogId, env) => {
        if (!gameOfServer(catalogId)) return null;
        const loader = loaderForType(env.get(SOFTWARE_KEY) ?? "");
        return Boolean(loader && isPluginLoader(loader));
    },

    // A game server's world lives in memory between autosaves, and stopping or
    // redeploying destroys the container. Anything that is not a game server
    // has nothing to flush, and this costs it one query.
    beforeStop: async (ownerId, installedAppId) =>
        (await import("@/lib/apps/games-flush")).flushGameWorld(ownerId, installedAppId),

    // Starting it again is somebody saying the crash it was stopped for has been
    // dealt with. If it has not, the health sweep says so within a minute.
    afterStart: async (installedAppId) =>
        (await import("@/lib/apps/games-health")).clearCrashLoop(installedAppId),

    adopt: async (ownerId) =>
        (await import("@/lib/apps/game-install")).adoptGameServersApp(ownerId),

    gameServerSummaries: async (userId) =>
        (await (await games()).listGameServerFacts(userId)).map((server) => ({
            id: server.id,
            name: server.name,
            game: server.game,
            catalogName: server.catalogName,
            serverName: server.serverName,
            running: server.running,
            slots: server.slots
        })),

    forwardedPorts: async () => (await games()).listGamePorts(),

    readForwardedPorts: async (probe) => (await games()).readGamePorts(probe),

    firewallSlot: async (ownerId, applicationId) => {
        const game = await (await games()).gameServerForApplication(ownerId, applicationId);
        if (!game) return null;
        // Only Minecraft keeps a player list of names and addresses; the others
        // are pointed at their own page.
        const access =
            game.game === "minecraft"
                ? await (await import("@/lib/apps/minecraft/player-access"))
                      .listPlayerAccess(ownerId, game.installedAppId)
                      .catch(() => null)
                : null;
        return {
            app: GAME_SERVERS_APP_ID,
            kind: GAME_SLOTS.firewall,
            props: { installedAppId: game.installedAppId, game: game.game, access }
        };
    },

    installedPanelSlot: async (install) => {
        if (isGameManagerApp(install.catalogId)) {
            return { app: GAME_SERVERS_APP_ID, kind: GAME_SLOTS.home, props: {} };
        }
        if (!isGameServerApp(install.catalogId)) return null;
        // Detail on a page whose job is to manage the install, so it may not take
        // the page down: a server that cannot be described is precisely the one
        // somebody came to stop or remove.
        const { gameContextFor } = await import("@/app/(app)/apps/installed/[id]/game-context");
        const context = await gameContextFor(install).catch(() => null);
        return { app: GAME_SERVERS_APP_ID, kind: GAME_SLOTS.server, props: { context } };
    }
};
