/**
 * Game servers, as `polaris_search` finds them.
 *
 * Offered through the `mcpSearch` hook, beside the tools in `mcp-tools.ts`, and
 * held to the standing those read: the servers this account runs or was
 * invited to (`reachableInstallIds`), and a Minecraft server's events only
 * where the account holds that server's console grant - the events screen's
 * own rule, since running one talks to everybody on the server.
 *
 * Server-only.
 */

import { host } from "@polaris/app-host";
import type { AppHostTypes } from "@polaris/app-host";
import { listGameServerFacts } from "./games-service";
import { KIND_NAMES } from "./minecraft/events/catalog";

type McpSearchHit = AppHostTypes["McpSearchHit"];
type McpSearchProvider = AppHostTypes["McpSearchProvider"];

/** How many Minecraft servers' events one search reads. */
const EVENT_SERVERS = 10;

const serversProvider = () =>
    host.mcp.defineSearch({
        id: "game-servers.servers",
        app: "game-servers",
        category: "games",
        scope: "gameservers.read",
        async search(_query, caller, limit) {
            const user = await host.mcp.actingUser(caller.userId);
            if (!user) return [];
            const granted = await host.appsInstallAccess.reachableInstallIds(user, "games.read");
            const servers = await listGameServerFacts(user.id, granted);
            return servers.slice(0, limit).map(
                (server): McpSearchHit => ({
                    id: server.id,
                    name: server.name,
                    kind: "game server",
                    where: server.address,
                    keywords: [server.catalogName, server.game, "server"],
                    next: [
                        { tool: "games_server_status", args: { serverId: server.id } },
                        { tool: "games_server_power", args: { serverId: server.id } },
                        { tool: "games_console", args: { serverId: server.id } }
                    ]
                })
            );
        }
    });

const eventsProvider = () =>
    host.mcp.defineSearch({
        id: "game-servers.minecraft-events",
        app: "game-servers",
        category: "games",
        scope: "gameservers.manage",
        async search(_query, caller, limit) {
            const user = await host.mcp.actingUser(caller.userId);
            if (!user) return [];
            const granted = await host.appsInstallAccess.reachableInstallIds(user, "games.read");
            const minecraft = (await listGameServerFacts(user.id, granted))
                .filter((server) => server.catalogId.startsWith("minecraft"))
                .slice(0, EVENT_SERVERS);
            const { eventPresets } = await import("./minecraft/events/events-service");
            const lists = await Promise.all(
                minecraft.map(async (server) => {
                    const access = await host.appsInstallAccess.gameServerAccess(
                        user,
                        server.id,
                        "games.console"
                    );
                    if (!access) return [];
                    return (await eventPresets(server.id)).map(
                        (preset): McpSearchHit => ({
                            id: `${server.id}:${preset.id}`,
                            name: preset.name,
                            kind: "minecraft event",
                            where: server.name,
                            keywords: [
                                preset.kind,
                                KIND_NAMES[preset.kind].en,
                                KIND_NAMES[preset.kind].es,
                                "minecraft",
                                preset.enabled ? "on" : "off"
                            ],
                            next: [{ tool: "games_server_status", args: { serverId: server.id } }]
                        })
                    );
                })
            );
            return lists.flat().slice(0, limit);
        }
    });

/** Built when first asked for, as the tools are: `defineSearch` is the host's. */
let built: readonly McpSearchProvider[] | undefined;

export function gameMcpSearch(): readonly McpSearchProvider[] {
    built ??= [serversProvider(), eventsProvider()];
    return built;
}
