/**
 * A game server's address, as something a player types rather than an IP and a
 * port they have to be told.
 *
 * A Minecraft client resolves `_minecraft._tcp.<host>` before connecting, so a
 * SRV record pointing at the published port lets the address be just the name -
 * which is what a domain is for and why the server does not need to be on 25565
 * to look like it is. Bedrock clients do not resolve SRV, so there the name
 * still carries its port; the name is worth having anyway, because it survives
 * the machine's address changing.
 *
 * Everything here is best effort. A server whose DNS could not be written is
 * still a server: it falls back to the address it always had.
 */

import { gameMessage } from "../game-message";
import {
    MINECRAFT_ROUTER_ASLEEP_MOTD,
    MINECRAFT_ROUTER_LOADING_MOTD,
    PROBE_TIMEOUT_MS,
    routesByHostname
} from "@polaris/core";
import { prisma } from "@polaris/db";
import { normalizeZoneName } from "@polaris/deploy";
import { connect } from "node:net";
import { readJavaStatus, statusDescription } from "./slp";
import {
    ROUTE_CANDIDATE_KEY,
    minecraftRoutes,
    routerAddress,
    syncMinecraftRoutes
} from "./router-service";
import { host } from "@polaris/app-host";
import { MINECRAFT_SRV_PREFIX, releaseGameDns, rememberGameDnsRecord } from "../game-dns";

const { getPublicIp } = host.domainService;
const { getDomainZones } = host.domainZones;
const { provisionHostnameDns } = host.domainDns;
const { patchInstallConfig, readInstallConfig } = host.appsInstallConfig;
const { loadCloudflareToken } = host.integrationsCloudflareAccountService;
const { startRouter, stopRouter } = host.minecraftRouter;
const { publicProbeHost } = host.netPortProbe;
const { relayAddress } = host.appsPortAdvice;
const { deleteDnsRecord, findDnsRecords, resolveZoneForHostname, upsertSrvRecord } =
    host.integrationsCloudflareApi;

/** The label game servers live under, so they never collide with a deployed
 *  service's name: `survival.mc.example.com`. One per game, because two games'
 *  servers would otherwise be competing for the same subdomain - and "survival"
 *  is a name somebody will pick twice. */
const GAME_LABEL = "mc";

export interface GameAddress {
    /** The hostname a player connects to, when there is one. */
    readonly hostname: string | null;
    /** Whether a client reaches it without also being told the port. */
    readonly portless: boolean;
}

/** The hostname a server would take on this Polaris, or null when no domain is
 *  configured. Deterministic from the name, so it survives a redeploy. */
export async function gameHostname(
    name: string,
    subdomain?: string,
    gameLabel: string = GAME_LABEL
): Promise<string | null> {
    const { baseDomain } = await getDomainZones();
    if (!baseDomain) return null;
    const label = normalizeZoneName(subdomain?.trim() || name);
    return label ? `${label}.${gameLabel}.${baseDomain}` : null;
}

/** Whether a hostname is already taken by another of this owner's servers. */
export async function hostnameTaken(
    ownerId: string,
    hostname: string,
    exceptInstallId?: string
): Promise<boolean> {
    const rows = await prisma.installedApp.findMany({
        where: { ownerId, status: { not: "removed" } },
        select: { id: true, config: true }
    });
    return rows.some((row) => {
        if (row.id === exceptInstallId) return false;
        try {
            return (JSON.parse(row.config) as { hostname?: unknown }).hostname === hostname;
        } catch {
            return false;
        }
    });
}

/**
 * Point a hostname at this machine and, for Java, at the port too.
 *
 * The A record is the same one a custom domain gets, conflicts and all - a name
 * already pointing somewhere else is left alone rather than taken over. The SRV
 * record is what removes the port from what a player has to type, and it is only
 * written once the A record it targets exists.
 *
 * Every record actually written is remembered against the server, so deleting it
 * removes exactly those. A name a wildcard already answered for wrote nothing, and
 * there is nothing to remember.
 */
export async function provisionGameDns(
    hostname: string,
    port: number,
    srv: boolean,
    owner: { ownerId: string; installedAppId: string }
): Promise<GameAddress> {
    const result = await provisionHostnameDns(hostname);
    if (result.status === "conflict" || result.status === "manual")
        return { hostname: null, portless: false };
    if (result.status === "created" && result.recordId && result.zoneId) {
        await rememberGameDnsRecord({
            ...owner,
            zoneId: result.zoneId,
            recordId: result.recordId,
            type: "A",
            name: hostname
        }).catch(() => undefined);
    }
    // Only a Minecraft: Java client looks a SRV record up. Bedrock does not, and
    // neither does ARK - there the name is still worth having, it just carries its
    // port the way it always did.
    if (!srv) return { hostname, portless: false };
    try {
        const token = await loadCloudflareToken();
        if (!token) return { hostname, portless: false };
        const zone = await resolveZoneForHostname(token, hostname);
        const name = `${MINECRAFT_SRV_PREFIX}${hostname}`;
        const recordId = await upsertSrvRecord(token, zone.id, name, hostname, port);
        await rememberGameDnsRecord({
            ...owner,
            zoneId: zone.id,
            recordId,
            type: "SRV",
            name
        }).catch(() => undefined);
        return { hostname, portless: true };
    } catch {
        // The name resolves either way; only the port stays part of the address.
        return { hostname, portless: false };
    }
}

/** The address to show, from what the server has: its name when it has one, and
 *  the port when the name alone does not carry it. */
export function formatGameAddress(
    address: GameAddress | null,
    fallback: string | null,
    port: number
): string | null {
    if (!address?.hostname) return fallback;
    return address.portless ? address.hostname : `${address.hostname}:${port}`;
}

/** The ports a client tries when the player types no port at all, Java then
 *  Bedrock. An address already on one of them is shorter and less to get wrong. */
const IMPLIED_PORTS = [25565, 19132];

/**
 * What a player types to connect, from what Polaris knows about the server: its
 * name on the operator's domain when it has one, otherwise the machine's own
 * address. Null when neither is known - better no address than one that does not
 * resolve.
 *
 * Pure, and the only place the rule lives: the list builds it for every server
 * from one batch of records, and a server's own page builds it from that
 * server's, and the two must not be able to disagree.
 */
export function gameServerAddress(server: {
    hostname: string | null;
    portless: boolean;
    /** The machine's address, for a server with no name of its own. */
    ip: string | null;
    port: number;
}): string | null {
    if (server.hostname)
        return server.portless ? server.hostname : `${server.hostname}:${server.port}`;
    if (!server.ip) return null;
    return IMPLIED_PORTS.includes(server.port) ? server.ip : `${server.ip}:${server.port}`;
}

/**
 * Give a server its name on the operator's domain, and record it.
 *
 * Shared by creating a server and by changing its address afterwards, because they
 * are the same act: work out the name, refuse one already spoken for, point it at
 * this machine and at the port, and write down what a player has to type. A server
 * with no domain configured, or no published port to point a record at, keeps the
 * address it already had rather than losing one.
 *
 * The config is merged rather than replaced - it also carries the server's access
 * settings, and a rename must not quietly reopen it.
 */
export async function setGameHostname(
    ownerId: string,
    installedAppId: string,
    input: {
        name: string;
        subdomain?: string;
        /** Whether the client finds the port for itself once the name resolves. */
        srv: boolean;
        /** The game's own label, so two games' servers cannot take the same name. */
        gameLabel?: string;
    }
): Promise<string | null> {
    const wanted = await gameHostname(input.name, input.subdomain, input.gameLabel);
    if (!wanted) return null;
    if (await hostnameTaken(ownerId, wanted, installedAppId)) {
        throw new Error(gameMessage("games", "lib.subdomainTaken", { name: wanted }));
    }
    const install = await prisma.installedApp.findFirst({
        where: { id: installedAppId, ownerId },
        select: { applicationId: true, config: true }
    });
    const port = install?.applicationId ? await publishedPort(install.applicationId) : null;
    if (!port) return null;
    // A routed server needs no SRV record: the router answers on the default port and
    // reads the name out of the handshake, so the port was never part of the address.
    // Asking for one anyway would write a record per server, which is the thing
    // routing exists to stop.
    const routed = readInstallConfig(install?.config).routed === true;
    const address = await provisionGameDns(wanted, port, input.srv && !routed, {
        ownerId,
        installedAppId
    });
    if (!address.hostname) return null;
    await patchInstallConfig(installedAppId, {
        hostname: address.hostname,
        portless: routed || address.portless
    });
    // A rename leaves the old name's records pointing at a server that no longer
    // answers to it: only the new name's survive, and the SRV only if it was written.
    await releaseGameDns(installedAppId, [
        address.hostname,
        ...(address.portless ? [`${MINECRAFT_SRV_PREFIX}${address.hostname}`] : [])
    ]);
    // The table names servers by hostname, so a rename has to reach it or the old
    // name keeps routing and the new one reaches nothing.
    const candidate = readInstallConfig(install?.config)[ROUTE_CANDIDATE_KEY] === true;
    if (routed || candidate) await syncMinecraftRoutes().catch(() => undefined);
    return address.hostname;
}

/**
 * Switch a server between the two ways its address can carry no port: a SRV record
 * of its own, or the hostname router.
 *
 * Routing is the one that scales - a routed server costs no DNS record at all - but
 * it changes what the server itself sees, because connections then arrive from the
 * router rather than from the player. That is why it is a choice per server and not
 * a setting for the instance, and why turning it on is refused for a server whose
 * player list is bound to addresses: that check reads the address off the join line,
 * and through the router every join looks like it came from the same place. Silently
 * weakening it would be the worst outcome of the three.
 *
 * Turning it on drops the SRV record, which is the point (it named the old port and
 * is one record per server); turning it off writes it back, so the address a player
 * already has keeps working either way.
 */
export async function setGameRouted(
    ownerId: string,
    installedAppId: string,
    routed: boolean
): Promise<void> {
    const install = await prisma.installedApp.findFirst({
        where: { id: installedAppId, ownerId },
        select: { applicationId: true, catalogId: true, config: true }
    });
    if (!install) throw new Error(gameMessage("games", "lib.noSuchServer"));
    // Only a client that puts the address in its handshake can be routed by it.
    if (!routesByHostname(install.catalogId)) {
        throw new Error(gameMessage("games", "lib.sharePortJavaOnly"));
    }
    const config = readInstallConfig(install.config);
    // Read the way the enforcement pass reads it, where an absent switch is on: a
    // server that never touched it holds its players to their addresses, and routing
    // it would have the pass refuse every one of them.
    if (routed && !(await routingKeepsPlayerList(installedAppId))) {
        throw new Error(gameMessage("games", "lib.boundBehindRouter"));
    }
    // Turning routing on drops the SRV record that carried this server's port, so
    // doing it with no router listening would take a working address away and leave
    // nothing in its place. The router is Polaris's to run, though, so the answer is
    // to start it rather than to refuse and tell somebody to go and edit a file.
    //
    // The table is written first, empty or not: the router watches that file, and a
    // watch on a file that does not exist kills it at startup.
    if (routed && !(await routerListening())) {
        await syncMinecraftRoutes().catch(() => undefined);
        const failed = await startRouter(routerPort());
        if (failed) throw new Error(failed);
        // It binds a second or so after the container starts, and the caller is a
        // person waiting on a switch: waiting here is the difference between this
        // working and this asking them to press it again.
        if (!(await waitForRouter())) {
            throw new Error(gameMessage("games", "lib.routerSilent", { port: routerPort() }));
        }
    }
    const hostname = typeof config.hostname === "string" ? config.hostname : "";
    const port = install.applicationId ? await publishedPort(install.applicationId) : null;

    // The new way in is established before the old one is taken away, in both
    // directions. Doing it the other way round leaves a window - however short - where
    // the address a player already has answers nowhere.
    if (routed) {
        await moveOntoRouter(ownerId, installedAppId, hostname, port, true);
        return;
    }
    const srvWritten =
        hostname && port
            ? await setSrvRecord(hostname, port, true, { ownerId, installedAppId })
            : false;
    // Off the router, the port is out of the address only if that record was actually
    // written - otherwise it goes back to carrying it, which is what a player needs.
    await patchInstallConfig(installedAppId, {
        routed: false,
        portless: srvWritten,
        [ROUTE_CANDIDATE_KEY]: false
    });
    await syncMinecraftRoutes().catch(() => undefined);
    // The last server off the router leaves it holding a port for an empty table.
    // Only ever the one Polaris started: an install running the router from its
    // compose profile has a project this does not name, and keeps it.
    if ((await minecraftRoutes().catch(() => [])).length === 0) {
        await stopRouter().catch(() => undefined);
    }
}

/**
 * Mark a server routed and drop the SRV record that carried its port, in that
 * order: the route is in the table before the record goes.
 *
 * `syncTable` is off only for a server whose route the table already holds (a
 * candidate's), so a sweep switching many over writes the table once, at its end.
 */
async function moveOntoRouter(
    ownerId: string,
    installedAppId: string,
    hostname: string,
    port: number | null,
    syncTable: boolean
): Promise<void> {
    // The router answers on the default port, so the name alone is the address.
    await patchInstallConfig(installedAppId, {
        routed: true,
        portless: true,
        [ROUTE_CANDIDATE_KEY]: false
    });
    if (syncTable) await syncMinecraftRoutes().catch(() => undefined);
    if (hostname && port) await setSrvRecord(hostname, port, false, { ownerId, installedAppId });
}

/** How long to give a router that has just been started, and how often to look. */
const ROUTER_WAIT_TRIES = 6;
const ROUTER_WAIT_MS = 1000;

/** Whether it came up, waiting the few seconds a container takes to bind. */
async function waitForRouter(): Promise<boolean> {
    for (let attempt = 0; attempt < ROUTER_WAIT_TRIES; attempt += 1) {
        if (await routerListening()) return true;
        await new Promise((wake) => setTimeout(wake, ROUTER_WAIT_MS));
    }
    return false;
}

/** The port the hostname router answers on, which is the default Minecraft port
 *  unless the operator moved it. */
export function routerPort(): number {
    const configured = Number(process.env.POLARIS_MC_ROUTER_PORT);
    return Number.isInteger(configured) && configured > 0 && configured < 65536
        ? configured
        : 25565;
}

/** How long a check on the router waits before calling it silent. */
const ROUTER_PROBE_MS = 1500;

/**
 * Whether the hostname router is actually up.
 *
 * A TCP connect to the router by its service name on the dashboard's own network,
 * which only resolves while a router container is on it - so unlike a connect to
 * the host's port, a Minecraft server that happens to hold 25565 does not read as
 * the router. A status ping would not do: mc-router drops a handshake naming a
 * hostname it has no route for, which is exactly what an empty table is.
 */
export async function routerListening(): Promise<boolean> {
    const { host: name, port } = routerAddress();
    return new Promise((resolve) => {
        const socket = connect({ host: name, port, timeout: ROUTER_PROBE_MS });
        const settle = (up: boolean): void => {
            socket.destroy();
            resolve(up);
        };
        socket.once("connect", () => settle(true));
        socket.once("timeout", () => settle(false));
        socket.once("error", () => settle(false));
    });
}

/** Whether the router answers for this name: a status ping through it, naming the
 *  server, that the server itself replies to. The route proven end to end on this
 *  network - everything but the public forward to the port. */
export async function routeAnswers(hostname: string): Promise<boolean> {
    const { host: name, port } = routerAddress();
    return serverAnswersThrough(name, port, ROUTER_PROBE_MS * 2, hostname);
}

/** The texts the router answers a ping with itself, for a server it cannot reach:
 *  Polaris's own, and whatever the compose profile was told to use instead. */
function routerOwnMotds(): Set<string> {
    return new Set(
        [
            MINECRAFT_ROUTER_ASLEEP_MOTD,
            MINECRAFT_ROUTER_LOADING_MOTD,
            process.env.POLARIS_MC_ASLEEP_MOTD,
            process.env.POLARIS_MC_LOADING_MOTD
        ]
            .map((text) => text?.trim() ?? "")
            .filter(Boolean)
    );
}

/** Whether a status ping through the router, naming the server, was answered by
 *  the server itself rather than by the router standing in for it. */
async function serverAnswersThrough(
    address: string,
    port: number,
    timeoutMs: number,
    hostname: string
): Promise<boolean> {
    const status = await readJavaStatus(address, port, timeoutMs, hostname);
    if (status === null) return false;
    return !routerOwnMotds().has(statusDescription(status));
}

/** How long a public check that failed stands before it is asked again. A forward
 *  is made once and left alone, so asking on every sweep only spends the timeout. */
const FORWARD_RETRY_MS = 10 * 60_000;

/** When each install's public check last failed. Per process: a rate limit, not a
 *  record - a success is recorded by switching the server over. */
const forwardFailedAt = new Map<string, number>();

/**
 * Whether the router's port answers for this name from outside: the same ping, to
 * the address players arrive at, so it also proves the forward to the router's
 * port. Only ever positive evidence - a router that will not loop its own address
 * back inward is silent here too - so silence leaves the server on its SRV record,
 * which keeps working.
 */
export async function forwardAnswers(installedAppId: string, hostname: string): Promise<boolean> {
    const failed = forwardFailedAt.get(installedAppId);
    if (failed !== undefined && Date.now() - failed < FORWARD_RETRY_MS) return false;
    const address =
        (await relayAddress().catch(() => null)) ?? (await publicProbeHost().catch(() => null));
    const answered = address
        ? await serverAnswersThrough(address, routerPort(), PROBE_TIMEOUT_MS, hostname)
        : false;
    if (answered) forwardFailedAt.delete(installedAppId);
    else forwardFailedAt.set(installedAppId, Date.now());
    return answered;
}

/** Whether routing would leave this server's player list meaning what it says. */
async function routingKeepsPlayerList(installedAppId: string): Promise<boolean> {
    const { addressesSurviveRouting } = await import("./player-access");
    return addressesSurviveRouting(installedAppId).catch(() => false);
}

/**
 * Put a server that has just been created on the shared port, when it can be.
 *
 * The default for a new Java server, because routing is what keeps the address
 * from costing a DNS record each. Best effort and safe to fail: the server already
 * has its SRV record, and `setGameRouted` changes nothing until the router is up -
 * starting it when nothing is answering, and giving up when the port is held by
 * something that is not the router. Either way the SRV record is what is left, so
 * the address the server was just given keeps working.
 *
 * Returns whether it is routed.
 */
export async function routeNewServer(ownerId: string, installedAppId: string): Promise<boolean> {
    try {
        if (!(await routingKeepsPlayerList(installedAppId))) return false;
        await setGameRouted(ownerId, installedAppId, true);
        return true;
    } catch {
        return false;
    }
}

/**
 * Move an existing server onto the shared port, only once that is proven to work.
 *
 * Called by the sweep for every server. A server is a candidate when it is Java,
 * has a name, nobody ever chose for it (`routed` absent - a server somebody took
 * off the router stays off), and routing keeps its player list intact. A candidate
 * is added to the table while its SRV record stays where it is; on a later pass the
 * router is asked for it by name, and only an answer from the server itself - on
 * this network and then from outside, through the forward to the router's port -
 * switches it over and drops the record. A router that is not running, a server
 * that is stopped, or a forward that is missing leaves it exactly as it was.
 *
 * Never starts the router: an install that has not asked for it keeps 25565 free.
 *
 * Returns whether it was switched over by this pass.
 */
export async function adoptRoutedAddress(
    ownerId: string,
    installedAppId: string
): Promise<boolean> {
    const install = await prisma.installedApp.findFirst({
        where: { id: installedAppId, ownerId },
        select: { applicationId: true, catalogId: true, config: true }
    });
    if (!install || !routesByHostname(install.catalogId)) return false;
    const config = readInstallConfig(install.config);
    if (config.routed !== undefined) return false;
    const hostname =
        typeof config.hostname === "string" ? config.hostname.trim().toLowerCase() : "";
    if (!hostname) return false;
    const candidate = config[ROUTE_CANDIDATE_KEY] === true;
    if (!(await routingKeepsPlayerList(installedAppId))) {
        if (candidate) await patchInstallConfig(installedAppId, { [ROUTE_CANDIDATE_KEY]: false });
        return false;
    }
    // First pass: into the table, which the sweep writes once at its end. The router
    // waits for the file to settle before reading it, so this one is asked next time.
    if (!candidate) {
        await patchInstallConfig(installedAppId, { [ROUTE_CANDIDATE_KEY]: true });
        return false;
    }
    if (!(await routeAnswers(hostname))) return false;
    // The SRV record carries players who dial the server's own forwarded port, so it
    // only goes once the router's port answers for this name from outside as well.
    // An install that never forwarded it keeps the addresses its players already use.
    if (!(await forwardAnswers(installedAppId, hostname))) return false;
    const port = install.applicationId ? await publishedPort(install.applicationId) : null;
    // The route is already in the table, as a candidate's, so the sweep's own write
    // at its end is the only one this needs.
    await moveOntoRouter(ownerId, installedAppId, hostname, port, false);
    return true;
}

/**
 * Write or remove the SRV record that carries a server's port, and say whether the
 * record is now what was asked for.
 *
 * Best effort on purpose: the name resolves either way, so a zone this token cannot
 * reach costs the port being part of the address rather than the address itself.
 */
async function setSrvRecord(
    hostname: string,
    port: number,
    wanted: boolean,
    owner: { ownerId: string; installedAppId: string }
): Promise<boolean> {
    try {
        const token = await loadCloudflareToken();
        if (!token) return false;
        const zone = await resolveZoneForHostname(token, hostname);
        const name = `${MINECRAFT_SRV_PREFIX}${hostname}`;
        if (wanted) {
            const recordId = await upsertSrvRecord(token, zone.id, name, hostname, port);
            await rememberGameDnsRecord({
                ...owner,
                zoneId: zone.id,
                recordId,
                type: "SRV",
                name
            }).catch(() => undefined);
            return true;
        }
        for (const record of await findDnsRecords(token, zone.id, "SRV", name)) {
            await deleteDnsRecord(token, zone.id, record.id);
        }
        // Gone by name, so whatever remembered it has nothing left to remove.
        await prisma.gameDnsRecord
            .deleteMany({
                where: { installedAppId: owner.installedAppId, name: name.toLowerCase() }
            })
            .catch(() => undefined);
        return false;
    } catch {
        return false;
    }
}

/** The host port the install pinned for this application, which is what a SRV
 *  record has to name. */
async function publishedPort(applicationId: string): Promise<number | null> {
    const app = await prisma.application.findUnique({
        where: { id: applicationId },
        select: { sourceConfig: true }
    });
    if (!app) return null;
    try {
        const config = JSON.parse(app.sourceConfig) as { hostPort?: unknown };
        return typeof config.hostPort === "number" ? config.hostPort : null;
    } catch {
        return null;
    }
}

/** The suffix every game server's name ends in on this Polaris (".mc.example.com"),
 *  so a screen can show what a chosen label will become. Null with no domain. */
export async function gameDomainSuffix(gameLabel?: string): Promise<string | null> {
    const example = await gameHostname("server", undefined, gameLabel);
    return example ? example.slice("server".length) : null;
}

/** What Polaris could not detect: the public address a name has to point at. */
export async function publicAddressKnown(): Promise<boolean> {
    return Boolean(await getPublicIp());
}
