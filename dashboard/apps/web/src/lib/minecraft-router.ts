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
import { SshPorts } from "@/lib/deploy/ports-ssh";
import { borrowSsh } from "@/lib/connection-pool";
import { HostdClient } from "@polaris/hostd-client";
import { HostdPorts } from "@/lib/deploy/ports-hostd";
import { MINECRAFT_ROUTER_ASLEEP_MOTD, MINECRAFT_ROUTER_LOADING_MOTD } from "@polaris/core";
import { execCommand } from "@polaris/ssh";
import { getHostConnectionUnscoped } from "@/lib/host-service";
import { quoteArg, type ComposeSpec } from "@polaris/deploy";

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
const ASLEEP_MOTD = MINECRAFT_ROUTER_ASLEEP_MOTD;
const LOADING_MOTD = MINECRAFT_ROUTER_LOADING_MOTD;

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
            NetworkSettings?: { Networks?: Record<string, unknown> };
            Mounts?: { Destination?: string; Name?: string; Type?: string }[];
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

/*
 * One router per machine.
 *
 * Every route dials the published port of a server on the router's own machine, so a
 * router can only ever serve the servers beside it - and one table holding every
 * server everywhere would be rewritten, and re-read whole by the router, on every
 * change anywhere. So each machine that runs Java servers gets a router of its own,
 * holding only that machine's routes: a change touches one machine's table, and the
 * fleet grows a machine at a time. The machine Polaris runs on keeps the router
 * above, which is all a single-machine install ever has.
 *
 * A connected server is reached over the SSH the deploy pipeline uses, and its router
 * is deployed as the same one-service project through the same compose path
 * (`SshPorts.composeUp`). Its table is a file on that machine, under the volume root
 * bind mounts are confined to.
 */

/** The table's directory on a connected server, relative to the remote volume root:
 *  `/var/lib/polaris/volumes/polaris-mc-router`. */
const REMOTE_TABLE_BIND = ROUTER_PROJECT;
const REMOTE_TABLE_DIR = `/var/lib/polaris/volumes/${REMOTE_TABLE_BIND}`;
const REMOTE_TABLE_FILE = `${REMOTE_TABLE_DIR}/mc-routes.json`;

/** The same entry `@polaris/deploy` gives what it starts (its `HOST_GATEWAY`), which is
 *  what makes `host.docker.internal` the machine itself on Linux. */
const HOST_GATEWAY = "host.docker.internal:host-gateway";

/**
 * The router a connected server runs: the same image and table as the local one, on
 * no network of the dashboard's (there is none on that machine), reaching the servers
 * it routes through the host gateway, which is what `host.docker.internal` names there.
 *
 * Waking a sleeping server is left off: the knock goes to `web:3000`, a name only the
 * dashboard's own network resolves. A stopped server on a connected machine is
 * started from Polaris rather than by joining it.
 */
export function remoteRouterSpec(port: number): ComposeSpec {
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
                    CONNECTION_RATE_LIMIT: RATE_LIMIT
                },
                ports: [{ host: port, container: 25565, protocol: "tcp" as const }],
                volumes: [{ source: REMOTE_TABLE_BIND, target: ROUTES_DIR, kind: "bind" as const }],
                labels: {},
                networks: [],
                extraHosts: [HOST_GATEWAY],
                restart: "unless-stopped"
            }
        ],
        volumes: [],
        networks: []
    };
}

/**
 * The script that puts a table on a connected server, the bytes arriving on stdin.
 *
 * Written in place, not renamed over: mc-router watches the file itself, and a rename
 * replaces the inode the watch is on. stdin rather than an argument, because a busy
 * machine's table is megabytes and one argument to the remote shell stops at 128 KiB.
 */
export function remoteTableWriteScript(): string {
    return ["set -e", `mkdir -p ${quoteArg(REMOTE_TABLE_DIR)}`, `cat > ${quoteArg(REMOTE_TABLE_FILE)}`].join(
        "\n"
    );
}

/** Prints the table, or nothing when the machine has none yet. */
export function remoteTableReadScript(): string {
    return `cat ${quoteArg(REMOTE_TABLE_FILE)} 2>/dev/null || true`;
}

type HostConnection = Awaited<ReturnType<typeof getHostConnectionUnscoped>>;

/** How long a connected server gets to answer before its table is left for the next
 *  pass. Every machine is synced side by side, so this bounds the whole sweep. */
const HOST_READY_TIMEOUT_MS = 8_000;

/** A short command on a connected server, over a borrowed connection: the sweep asks
 *  every machine on every pass, and a handshake each time is most of what that costs. */
async function onHost(hostId: string, script: string, input?: string): Promise<{ code: number; out: string }> {
    const connection = await getHostConnectionUnscoped(hostId);
    const lease = await borrowSsh("exec", hostId, {
        host: connection.address,
        port: connection.port,
        username: connection.username,
        auth: connection.auth,
        pinnedHostKey: connection.hostKey ?? [],
        readyTimeoutMs: HOST_READY_TIMEOUT_MS
    });
    try {
        const chunks: Buffer[] = [];
        const result = await execCommand(lease.client, script, {
            input,
            onStdout: (chunk) => chunks.push(chunk)
        });
        return { code: result.code, out: Buffer.concat(chunks).toString("utf8") };
    } finally {
        lease.release();
    }
}

/** The table a connected server's router last read, or null when it has none. */
export async function readHostTable(hostId: string): Promise<string | null> {
    const { code, out } = await onHost(hostId, remoteTableReadScript());
    if (code !== 0) throw new Error("The routing table on that server could not be read.");
    return out === "" ? null : out;
}

/** Put a table on a connected server, where its router reads it. */
export async function writeHostTable(hostId: string, table: string): Promise<void> {
    const { code } = await onHost(hostId, remoteTableWriteScript(), table);
    if (code !== 0) throw new Error("The routing table on that server could not be written.");
}

function hostPorts(connection: HostConnection): SshPorts {
    return new SshPorts({
        address: connection.address,
        port: connection.port,
        username: connection.username,
        auth: connection.auth,
        hostKey: connection.hostKey,
        hostId: connection.id
    });
}

/** Whether the router Polaris deployed on a connected server is running. Asked of the
 *  engine by the project's label, so a Minecraft server holding the port there never
 *  reads as the router. */
export async function routerRunningOn(hostId: string): Promise<boolean> {
    const ports = hostPorts(await getHostConnectionUnscoped(hostId));
    try {
        return (await ports.listContainers(ROUTER_PROJECT)).length > 0;
    } finally {
        await ports.dispose();
    }
}

/**
 * Deploy, or repair, a connected server's router. `compose up -d` leaves a running
 * container with the same definition alone, so this is safe on every pass. The table
 * has to be there first, for the same reason as on this machine.
 */
export async function startRouterOn(hostId: string, port: number): Promise<string | null> {
    const connection = await getHostConnectionUnscoped(hostId).catch(() => null);
    if (!connection) return "Polaris cannot reach that server, so it cannot start the router there.";
    const ports = hostPorts(connection);
    try {
        await ports.composeUp(remoteRouterSpec(port));
        return null;
    } catch {
        return `The router could not be started on ${connection.name}. Check that nothing else on it is using port ${port}.`;
    } finally {
        await ports.dispose();
    }
}

/** Take a connected server's router down, once nothing there is routed. */
export async function stopRouterOn(hostId: string): Promise<void> {
    const connection = await getHostConnectionUnscoped(hostId).catch(() => null);
    if (!connection) return;
    const ports = hostPorts(connection);
    await ports.composeDown(ROUTER_PROJECT).catch(() => undefined);
    await ports.dispose().catch(() => undefined);
}
