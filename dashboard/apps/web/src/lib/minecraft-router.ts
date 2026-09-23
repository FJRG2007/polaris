/**
 * The hostname router, run by Polaris rather than by whoever edited a file.
 *
 * One port serves every Minecraft: Java server here, because a Java client names
 * the address it dialled in the handshake before it logs in - so `survival.example
 * .com` and `creative.example.com` both arrive on 25565 and are told apart by the
 * name (`game-servers/lib/minecraft/router-service.ts` writes the table). It is
 * also what makes a sleeping server startable: a stopped container has no port
 * open, and the router is the only thing left to notice somebody trying.
 *
 * It used to be a compose profile, which meant the screen had to say "add mcrouter
 * to COMPOSE_PROFILES and restart Polaris" - a terminal, a file and an install the
 * reader was told to go and edit for a feature they had just pressed a button for.
 * So the dashboard starts it itself, as its own one-service project, the same way
 * it deploys anything else: through the daemon, which renders and validates the
 * compose file.
 *
 * Two things are discovered rather than configured, because both are named after
 * the compose project this Polaris was installed as and that name is not ours to
 * assume: the network the dashboard is on (the router has to reach `web:3000` to
 * report a knock) and the volume the routing table is written to. The dashboard
 * asks the daemon about its own container and reads them off it.
 *
 * Server-only.
 */

import { hostname } from "node:os";
import type { ComposeSpec } from "@polaris/deploy";
import { HostdClient } from "@polaris/hostd-client";
import { HostdPorts } from "@/lib/deploy/ports-hostd";

/** Its own project, so it is started, stopped and updated on its own. */
export const ROUTER_PROJECT = "polaris-mc-router";

/** Pinned, like every other image Polaris runs for you. */
export const ROUTER_IMAGE = "itzg/mc-router:1.46.2";

/** Where the dashboard writes the table, inside the dashboard's container. The
 *  router mounts the same volume at the same place. */
const ROUTES_DIR = "/mc-routes";
const ROUTES_FILE = `${ROUTES_DIR}/mc-routes.json`;

/** Where a knock lands. Service DNS on the control plane's own network, which is
 *  not the network deployed apps are on. */
const WAKE_URL = "http://web:3000/api/minecraft/wake";

/** What a player's client shows for a server that is asleep, and for one that is
 *  coming up. Without the first, a ping for a sleeping server is answered with
 *  nothing and reads as the server being gone. */
const ASLEEP_MOTD = "Asleep - join to start it";
const LOADING_MOTD = "Starting up - join again in a moment";

/** How long the router keeps waiting for a server it asked us to start. Longer
 *  than a cold Minecraft server takes to answer, and it costs nothing: the
 *  player's own client gave up long before. */
const WAKE_TIMEOUT = "5m";

/** Connections a second. Upstream's default is 1, which a queue of players
 *  rejoining after a restart trips over immediately. */
const RATE_LIMIT = "20";

export interface RouterPlacement {
    /** The network the dashboard is on, which the router joins to reach it. */
    readonly network: string;
    /** The volume the routing table lives on. */
    readonly routesVolume: string;
}

/**
 * Where this dashboard is, as the daemon sees it.
 *
 * Read off our own container rather than assumed: both names carry the compose
 * project this Polaris was installed as, and an install named something else
 * would have a router that joins nothing and reads no table - which looks exactly
 * like a router that is simply not working.
 */
export async function routerPlacement(): Promise<RouterPlacement | null> {
    try {
        const client = new HostdClient();
        const answer = await client.dockerRequest("GET", `/containers/${hostname()}/json`);
        if (answer.status !== 200) return null;
        const body = JSON.parse(answer.body) as {
            NetworkSettings?: { Networks?: Record<string, unknown>; };
            Mounts?: { Destination?: string; Name?: string; Type?: string; }[];
        };
        // The dashboard is on more than one network - the control plane's own, and
        // the dedicated one a locally installed messaging bridge joins - and the
        // order they come back in is not ours to rely on. The control plane's is the
        // compose project's default network, which is the one whose name ends there.
        const joined = Object.keys(body.NetworkSettings?.Networks ?? {});
        const network = joined.find((name) => name.endsWith("_default")) ?? joined[0];
        const routes = (body.Mounts ?? []).find(
            (mount) => mount.Destination === ROUTES_DIR && mount.Type === "volume" && mount.Name
        );
        if (!network || !routes?.Name) return null;
        return { network, routesVolume: routes.Name };
    } catch {
        return null;
    }
}

/** The one-service project the daemon renders. */
export function routerSpec(placement: RouterPlacement, port: number): ComposeSpec {
    return {
        project: ROUTER_PROJECT,
        services: [
            {
                name: "mc-router",
                image: ROUTER_IMAGE,
                pullPolicy: "always" as const,
                env: {
                    ROUTES_CONFIG: ROUTES_FILE,
                    ROUTES_CONFIG_WATCH: "true",
                    CONNECTION_RATE_LIMIT: RATE_LIMIT,
                    AUTO_SCALE_UP: "true",
                    AUTO_SCALE_WEBHOOK_URL: WAKE_URL,
                    AUTO_SCALE_WEBHOOK_WAKE_TIMEOUT: WAKE_TIMEOUT,
                    AUTO_SCALE_ASLEEP_MOTD: ASLEEP_MOTD,
                    AUTO_SCALE_LOADING_MOTD: LOADING_MOTD
                },
                ports: [{ host: port, container: 25565, protocol: "tcp" as const }],
                volumes: [
                    { source: placement.routesVolume, target: ROUTES_DIR, kind: "volume" as const }
                ],
                labels: {},
                networks: [placement.network],
                restart: "unless-stopped"
            }
        ],
        // Nothing of its own: the one volume it mounts is the dashboard's, named
        // exactly and declared external, so this project never owns or removes it.
        volumes: [],
        networks: [placement.network],
        externalVolumes: [placement.routesVolume]
    };
}

/**
 * Start the router, and say in a sentence what stopped it if it did not start.
 *
 * The caller checks the port first and only calls this when nothing is answering
 * on it: an install still running the router from its compose profile has one
 * already, and taking that over would be a restart nobody asked for.
 *
 * The table has to exist before this. mc-router watches that file, and a watch on
 * a file that is not there is fatal at startup - it exits, which on an install
 * where nothing has been routed yet would be a router that dies the moment it is
 * asked for. `syncMinecraftRoutes` writes it, empty table included.
 */
export async function startRouter(port: number): Promise<string | null> {
    const placement = await routerPlacement();
    if (!placement) {
        return "Polaris cannot see its own container, so it cannot start the router. This needs the full edition, where the host daemon is running.";
    }
    try {
        await new HostdPorts().composeUp(routerSpec(placement, port));
        return null;
    } catch {
        return `The router could not be started. Check that nothing else on this machine is using port ${port}.`;
    }
}

/** Take it down. Only ever the project Polaris started - an install running the
 *  router from its compose profile keeps it. */
export async function stopRouter(): Promise<void> {
    await new HostdPorts().composeDown(ROUTER_PROJECT).catch(() => undefined);
}
