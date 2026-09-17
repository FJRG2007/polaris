/**
 * Game servers, as core sees it: the one object that answers every question the
 * dashboard asks of this app.
 *
 * Core never imports Game servers' modules; it asks the app extension registry,
 * and this is what is registered there. Everything the app does for a core
 * screen, a core job or a core pass is reached through here.
 */

import { isGameServerApp } from "@/lib/apps/catalog";
import { gameServerJobs } from "@/lib/apps/games-jobs";
import { flushGameWorld } from "@/lib/apps/games-flush";
import { clearCrashLoop } from "@/lib/apps/games-health";
import { adoptGameServersApp } from "@/lib/apps/game-install";
import type { AppExtension } from "@/lib/app-extensions/types";
import { SOFTWARE_KEY } from "@/lib/apps/minecraft/join-guard";
import { minecraftImageFor } from "@/lib/apps/minecraft/runtime";
import { listPlayerAccess } from "@/lib/apps/minecraft/player-access";
import { minecraftWorldSource } from "@/lib/backups/sources/minecraft";
import { isPluginLoader, loaderForType } from "@/lib/apps/minecraft/modrinth";
import { gameContextFor } from "@/app/(app)/apps/installed/[id]/game-context";
import { GAME_SERVERS_APP_ID, gameOfServer, isGameManagerApp } from "@/lib/apps/games-catalog";
import {
    gameServerForApplication,
    listGamePorts,
    listGameServerFacts,
    readGamePorts
} from "@/lib/apps/games-service";

/** The slot kinds this app draws, which its client registry renders. */
export const GAME_SLOTS = {
    firewall: "firewall",
    home: "app-home",
    server: "server"
} as const;

export const gameServersExtension: AppExtension = {
    id: GAME_SERVERS_APP_ID,

    jobs: gameServerJobs,

    backupSources: () => ({ "minecraft-world": minecraftWorldSource }),

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
    beforeStop: flushGameWorld,

    // Starting it again is somebody saying the crash it was stopped for has been
    // dealt with. If it has not, the health sweep says so within a minute.
    afterStart: clearCrashLoop,

    adopt: adoptGameServersApp,

    gameServerSummaries: async (userId) =>
        (await listGameServerFacts(userId)).map((server) => ({
            id: server.id,
            name: server.name,
            game: server.game,
            catalogName: server.catalogName,
            serverName: server.serverName,
            running: server.running,
            slots: server.slots
        })),

    forwardedPorts: listGamePorts,

    readForwardedPorts: readGamePorts,

    firewallSlot: async (ownerId, applicationId) => {
        const game = await gameServerForApplication(ownerId, applicationId);
        if (!game) return null;
        // Only Minecraft keeps a player list of names and addresses; the others
        // are pointed at their own page.
        const access =
            game.game === "minecraft"
                ? await listPlayerAccess(ownerId, game.installedAppId).catch(() => null)
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
        const context = await gameContextFor(install).catch(() => null);
        return { app: GAME_SERVERS_APP_ID, kind: GAME_SLOTS.server, props: { context } };
    }
};
