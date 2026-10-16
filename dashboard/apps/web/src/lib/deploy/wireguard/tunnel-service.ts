/**
 * WireGuard tunnels: publish a service that runs behind NAT through one of the
 * owner's servers that has a public address.
 *
 * Polaris makes both key pairs, keeps the private halves encrypted with the master
 * key, and only ever writes a private key into the config of the end it belongs
 * to. The public end listens on one UDP port; the end behind NAT dials it with a
 * keepalive, so nothing opens at home. The public server's edge routes the
 * hostname to its end of the tunnel.
 *
 * What Polaris cannot do is open that UDP port in the public server's provider
 * firewall. The screen names the port and reads the handshake, so it says when
 * that rule starts working.
 */

import { prisma } from "@polaris/db";
import * as wg from "./tunnel-config";
import { normalizeHostname } from "./tunnel-hostname";
import { loadEnv } from "@polaris/config";
import { serviceName } from "@polaris/deploy";
import { getPorts } from "@/lib/deploy/runtime";
import { getPublicIp } from "@/lib/domain-service";
import { edgeHostnameTaken } from "@/lib/app-edge";
import { getHostConnection } from "@/lib/host-service";
import { containerPortOf } from "@/lib/deploy-service";
import { writeDynamicFile } from "@/lib/traefik-dynamic";
import { RemoteRouter } from "@/lib/deploy/router-remote";
import { decryptSecret, encryptSecret } from "@polaris/storage";
import { connectorNetworks } from "@/lib/deploy/service-networks";

/** A refusal the screen shows, by code; its sentence lives in the catalogs. */
export type TunnelRefusalCode =
    | "notFound"
    | "noServer"
    | "noService"
    | "sameServer"
    | "hostname"
    | "hostnameTaken"
    | "full"
    | "noAddress"
    | "unreachable"
    | "edge"
    | "leftover"
    | "leftoverPaused";

export class TunnelRefusal extends Error {
    public constructor(
        public readonly code: TunnelRefusalCode,
        /** Values for the sentence, such as the servers an end is still left on. */
        public readonly params: Record<string, string> = {}
    ) {
        super(code);
        this.name = "TunnelRefusal";
    }
}

export interface TunnelView {
    readonly id: string;
    readonly hostname: string;
    readonly listenPort: number;
    readonly paused: boolean;
    readonly publicServer: { id: string; name: string };
    readonly service: { id: string; name: string; project: string; server: string };
    /** Where the operator opens the UDP port: the public server's address. */
    readonly endpointHost: string | null;
    readonly createdAt: string;
}

export interface TunnelStatus {
    readonly health: wg.TunnelHealth | "paused" | "unknown";
    /** Unix seconds; 0 for never. */
    readonly lastHandshake: number;
    readonly rxBytes: number;
    readonly txBytes: number;
}

export interface TunnelOptions {
    readonly servers: { id: string; name: string; local: boolean }[];
    readonly services: { id: string; name: string; project: string; serverId: string }[];
}

const TARGET_SELECT = {
    id: true,
    name: true,
    kind: true,
    hostId: true,
    runtime: true,
    proxyNetwork: true
} as const;

/** Encrypt a private key for storage. */
export function sealKey(privateKey: string, masterKey = loadEnv().POLARIS_MASTER_KEY): string {
    const blob = encryptSecret(privateKey, masterKey);
    return JSON.stringify({
        c: blob.ciphertext.toString("base64"),
        n: blob.nonce.toString("base64"),
        k: blob.keyId
    });
}

/** Decrypt a stored private key. */
export function openKey(sealed: string, masterKey = loadEnv().POLARIS_MASTER_KEY): string {
    const { c, n, k } = JSON.parse(sealed) as { c: string; n: string; k: string };
    return decryptSecret(
        { ciphertext: Buffer.from(c, "base64"), nonce: Buffer.from(n, "base64"), keyId: k },
        masterKey
    );
}

/** What the create form can offer: the owner's servers and services. */
export async function tunnelOptions(ownerId: string): Promise<TunnelOptions> {
    const [targets, apps] = await Promise.all([
        prisma.deployTarget.findMany({
            where: { ownerId, status: "active" },
            select: { id: true, name: true, kind: true },
            orderBy: { name: "asc" },
            take: 200
        }),
        prisma.application.findMany({
            where: { environment: { project: { ownerId } } },
            select: {
                id: true,
                name: true,
                targetId: true,
                environment: { select: { project: { select: { name: true } } } }
            },
            orderBy: { name: "asc" },
            take: 500
        })
    ]);
    return {
        servers: targets.map((target) => ({
            id: target.id,
            name: target.name,
            local: target.kind === "local"
        })),
        services: apps.map((app) => ({
            id: app.id,
            name: app.name,
            project: app.environment.project.name,
            serverId: app.targetId
        }))
    };
}

/** The owner's tunnels, newest first. */
export async function listTunnels(ownerId: string): Promise<TunnelView[]> {
    const rows = await prisma.wireguardTunnel.findMany({
        where: { ownerId },
        orderBy: { createdAt: "desc" },
        take: 200,
        select: {
            id: true,
            hostname: true,
            listenPort: true,
            paused: true,
            createdAt: true,
            publicTarget: {
                select: { id: true, name: true, kind: true, host: { select: { address: true } } }
            },
            application: {
                select: {
                    id: true,
                    name: true,
                    target: { select: { name: true } },
                    environment: { select: { project: { select: { name: true } } } }
                }
            }
        }
    });
    const localIp = rows.some((row) => row.publicTarget.kind === "local")
        ? await getPublicIp()
        : null;
    return rows.map((row) => ({
        id: row.id,
        hostname: row.hostname,
        listenPort: row.listenPort,
        paused: row.paused,
        publicServer: { id: row.publicTarget.id, name: row.publicTarget.name },
        service: {
            id: row.application.id,
            name: row.application.name,
            project: row.application.environment.project.name,
            server: row.application.target.name
        },
        endpointHost:
            row.publicTarget.kind === "local" ? localIp : (row.publicTarget.host?.address ?? null),
        createdAt: row.createdAt.toISOString()
    }));
}

/** Create a tunnel and bring both ends up. */
export async function createTunnel(
    ownerId: string,
    input: { publicServerId: string; serviceId: string; hostname: string }
): Promise<{ id: string }> {
    const hostname = normalizeHostname(input.hostname);
    if (!wg.isRouteHostname(hostname)) throw new TunnelRefusal("hostname");
    const [target, app] = await Promise.all([
        prisma.deployTarget.findFirst({
            where: { id: input.publicServerId, ownerId },
            select: { id: true }
        }),
        prisma.application.findFirst({
            where: { id: input.serviceId, environment: { project: { ownerId } } },
            select: { id: true, targetId: true }
        })
    ]);
    if (!target) throw new TunnelRefusal("noServer");
    if (!app) throw new TunnelRefusal("noService");
    if (app.targetId === target.id) throw new TunnelRefusal("sameServer");
    if (await edgeHostnameTaken(hostname)) throw new TunnelRefusal("hostnameTaken");

    const publicPair = wg.generateKeyPair();
    const natPair = wg.generateKeyPair();
    // Two creates at once can pick the same slot or port; the unique indexes refuse
    // the second, and it picks again.
    let created: { id: string } | null = null;
    for (let attempt = 0; attempt < 3 && !created; attempt += 1) {
        const [slots, ports] = await Promise.all([
            prisma.wireguardTunnel.findMany({ where: { ownerId }, select: { slot: true } }),
            prisma.wireguardTunnel.findMany({
                where: { publicTargetId: target.id },
                select: { listenPort: true }
            })
        ]);
        const slot = wg.allocateSlot(slots.map((row) => row.slot));
        const listenPort = wg.allocateListenPort(ports.map((row) => row.listenPort));
        if (slot === null || listenPort === null) throw new TunnelRefusal("full");
        try {
            created = await prisma.wireguardTunnel.create({
                data: {
                    ownerId,
                    publicTargetId: target.id,
                    applicationId: app.id,
                    hostname,
                    listenPort,
                    slot,
                    publicKey: publicPair.publicKey,
                    privateKeySealed: sealKey(publicPair.privateKey),
                    peerPublicKey: natPair.publicKey,
                    peerPrivateKeySealed: sealKey(natPair.privateKey)
                },
                select: { id: true }
            });
        } catch (error) {
            if ((error as { code?: string }).code !== "P2002") throw error;
            const again = await prisma.wireguardTunnel.findUnique({
                where: { hostname },
                select: { id: true }
            });
            if (again) throw new TunnelRefusal("hostnameTaken");
        }
    }
    if (!created) throw new TunnelRefusal("full");
    try {
        await bringUp(ownerId, created.id);
    } catch (error) {
        // Half a tunnel is worse than none: take back what started and the row. A
        // server that cannot be reached keeps the row, paused, so it can be removed
        // once it is back.
        await removeTunnel(ownerId, created.id).catch(() => undefined);
        throw error;
    }
    return created;
}

/**
 * Stop both ends and take the hostname off the edge, keeping keys and settings.
 * A server that cannot be reached keeps its end running; the tunnel is still
 * recorded as paused and the refusal names that server.
 */
export async function setTunnelPaused(ownerId: string, id: string, paused: boolean): Promise<void> {
    const row = await loadTunnel(ownerId, id);
    if (row.paused === paused) return;
    await prisma.wireguardTunnel.update({ where: { id }, data: { paused } });
    if (paused) {
        refuseLeftovers(await takeDown(ownerId, id, row), "leftoverPaused");
        return;
    }
    try {
        await bringUp(ownerId, id);
    } catch (error) {
        // A resume that did not finish is a paused tunnel, not a half-running one.
        await prisma.wireguardTunnel.update({ where: { id }, data: { paused: true } });
        await takeDown(ownerId, id, row).catch(() => undefined);
        throw error;
    }
}

/**
 * Remove both ends, the route and the row. The row goes only once nothing is left
 * anywhere: while a server is unreachable the tunnel stays, paused, and the
 * refusal names what is still there, so removing it again finishes the job.
 */
export async function removeTunnel(ownerId: string, id: string): Promise<void> {
    const row = await loadTunnel(ownerId, id);
    if (!row.paused) await prisma.wireguardTunnel.update({ where: { id }, data: { paused: true } });
    refuseLeftovers(await takeDown(ownerId, id, row));
    await prisma.wireguardTunnel.deleteMany({ where: { id, ownerId } });
}

function refuseLeftovers(
    left: readonly string[],
    code: "leftover" | "leftoverPaused" = "leftover"
): void {
    if (left.length > 0) throw new TunnelRefusal(code, { servers: [...new Set(left)].join(", ") });
}

/** What is about to be deleted under a tunnel: a service, or a whole server. */
export type TunnelScope = { readonly applicationId: string } | { readonly hostId: string };

/**
 * The tunnels a delete would cascade away: those reaching the service, or with
 * either end on the server. Read before anything changes, since moving a service
 * off the server rewrites where its end is recorded to run.
 */
export async function tunnelsWithin(ownerId: string, scope: TunnelScope): Promise<TunnelRow[]> {
    const where =
        "applicationId" in scope
            ? { ownerId, applicationId: scope.applicationId }
            : {
                  ownerId,
                  OR: [
                      { publicTarget: { hostId: scope.hostId } },
                      { application: { target: { hostId: scope.hostId } } }
                  ]
              };
    return prisma.wireguardTunnel.findMany({ where, select: TUNNEL_SELECT, take: 500 });
}

/**
 * Stop both ends of tunnels whose service or server is being deleted and take
 * their hostnames off the edge, before that delete cascades the rows away: with
 * no row left to remove it from, an end that stays running keeps its key and its
 * port for good. A tunnel cleaned up everywhere is deleted; one that is not stays,
 * paused, and is returned with the servers it is still left on.
 */
export async function retireTunnels(
    ownerId: string,
    rows: readonly TunnelRow[]
): Promise<{ hostname: string; servers: string }[]> {
    const left: { hostname: string; servers: string }[] = [];
    for (const row of rows) {
        await prisma.wireguardTunnel.updateMany({
            where: { id: row.id, ownerId },
            data: { paused: true }
        });
        const servers = await takeDown(ownerId, row.id, row);
        if (servers.length > 0)
            left.push({ hostname: row.hostname, servers: [...new Set(servers)].join(", ") });
        else await prisma.wireguardTunnel.deleteMany({ where: { id: row.id, ownerId } });
    }
    return left;
}

/**
 * Start a tunnel again where its service now runs, after the service moved to
 * another server. `before` is the tunnel as it was read before the move, so the
 * end that comes down is the one on the old server. A tunnel that was paused stays
 * paused; one that does not come up is left paused by `setTunnelPaused`. Returns
 * the servers where the old ends could not be cleaned up.
 */
export async function moveTunnel(ownerId: string, before: TunnelRow): Promise<string[]> {
    await prisma.wireguardTunnel.updateMany({
        where: { id: before.id, ownerId },
        data: { paused: true }
    });
    const left = await takeDown(ownerId, before.id, before);
    if (!before.paused) await setTunnelPaused(ownerId, before.id, false);
    return left;
}

/** Read the live state from whichever end answers, the public one first. */
export async function readTunnelStatus(
    ownerId: string,
    id: string,
    now = Date.now()
): Promise<TunnelStatus> {
    const status = (await readTunnelStatuses(ownerId, [id], now))[id];
    if (!status) throw new TunnelRefusal("notFound");
    return status;
}

/**
 * The live state of several tunnels at once. Each server is reached once for all
 * the ends it runs, every server at the same time; a tunnel its public server
 * could not report is asked of the server behind NAT. Ids that are not the
 * owner's are left out.
 */
export async function readTunnelStatuses(
    ownerId: string,
    ids: readonly string[],
    now = Date.now()
): Promise<Record<string, TunnelStatus>> {
    const rows = await prisma.wireguardTunnel.findMany({
        where: { id: { in: [...ids] }, ownerId },
        select: TUNNEL_SELECT,
        take: 500
    });
    const statuses: Record<string, TunnelStatus> = {};
    for (const row of rows) {
        if (row.paused)
            statuses[row.id] = { health: "paused", lastHandshake: 0, rxBytes: 0, txBytes: 0 };
    }
    const live = rows.filter((row) => !row.paused);
    await readEnds(
        ownerId,
        live.map((row) => ({
            id: row.id,
            target: row.publicTarget,
            helper: wg.endNames(row.id, "public").helper,
            peer: row.peerPublicKey
        })),
        now,
        statuses
    );
    await readEnds(
        ownerId,
        live
            .filter((row) => !statuses[row.id])
            .map((row) => ({
                id: row.id,
                target: row.application.target,
                helper: wg.endNames(row.id, "nat").helper,
                peer: row.publicKey
            })),
        now,
        statuses
    );
    for (const row of live)
        statuses[row.id] ??= { health: "unknown", lastHandshake: 0, rxBytes: 0, txBytes: 0 };
    return statuses;
}

interface EndToRead {
    readonly id: string;
    readonly target: TunnelRow["application"]["target"];
    readonly helper: string;
    readonly peer: string;
}

/** Read each end over one connection per server, filling in the ends that answered. */
async function readEnds(
    ownerId: string,
    ends: readonly EndToRead[],
    now: number,
    into: Record<string, TunnelStatus>
): Promise<void> {
    const byServer = new Map<string, { target: EndToRead["target"]; ends: EndToRead[] }>();
    for (const end of ends) {
        const server = byServer.get(end.target.id);
        if (server) server.ends.push(end);
        else byServer.set(end.target.id, { target: end.target, ends: [end] });
    }
    await Promise.all(
        [...byServer.values()].map(async (server) => {
            const ports = await getPorts(server.target, ownerId).catch(() => null);
            if (!ports) return;
            try {
                for (const end of server.ends) {
                    try {
                        const result = await ports.runIn(end.helper, wg.statusCommand());
                        if (result.code !== 0) continue;
                        const peer = wg
                            .parseDeviceState(result.output)
                            .find((one) => one.publicKeyHex === wg.keyToHex(end.peer));
                        if (!peer) continue;
                        into[end.id] = {
                            health: wg.tunnelHealth(peer.lastHandshake, Math.floor(now / 1000)),
                            lastHandshake: peer.lastHandshake,
                            rxBytes: peer.rxBytes,
                            txBytes: peer.txBytes
                        };
                    } catch {
                        // The other end may still answer.
                    }
                }
            } finally {
                await ports.dispose();
            }
        })
    );
}

const TUNNEL_SELECT = {
    id: true,
    hostname: true,
    listenPort: true,
    slot: true,
    paused: true,
    publicKey: true,
    privateKeySealed: true,
    peerPublicKey: true,
    peerPrivateKeySealed: true,
    publicTarget: { select: { ...TARGET_SELECT, host: { select: { address: true } } } },
    application: {
        select: {
            id: true,
            slug: true,
            sourceType: true,
            sourceConfig: true,
            domains: { select: { targetPort: true }, take: 1 },
            environment: { select: { project: { select: { slug: true } } } },
            target: { select: TARGET_SELECT }
        }
    }
} as const;

type TunnelRow = Awaited<ReturnType<typeof loadTunnel>>;

async function loadTunnel(ownerId: string, id: string) {
    const row = await prisma.wireguardTunnel.findFirst({
        where: { id, ownerId },
        select: TUNNEL_SELECT
    });
    if (!row) throw new TunnelRefusal("notFound");
    return row;
}

/** Start both ends from the stored keys and put the hostname on the public edge. */
async function bringUp(ownerId: string, id: string): Promise<void> {
    const row = await loadTunnel(ownerId, id);
    const host =
        row.publicTarget.kind === "local"
            ? await getPublicIp()
            : (row.publicTarget.host?.address ?? null);
    if (!host) throw new TunnelRefusal("noAddress");
    const endpoint = `${host.includes(":") ? `[${host}]` : host}:${row.listenPort}`;
    // Before the public end starts: it joins the edge's network, which a server
    // with no edge yet does not have.
    if (row.publicTarget.kind !== "local" && row.publicTarget.hostId) {
        await ensureEdge(row.publicTarget.hostId, ownerId, row.publicTarget.proxyNetwork);
    }
    const app = row.application;
    const origin = `${serviceName(app.environment.project.slug, app.slug, app.id)}:${containerPortOf(app)}`;

    const publicConfig = wg.renderPublicConfig({
        privateKey: openKey(row.privateKeySealed),
        peerPublicKey: row.peerPublicKey,
        slot: row.slot,
        listenPort: row.listenPort
    });
    const natConfig = wg.renderNatConfig({
        privateKey: openKey(row.peerPrivateKeySealed),
        peerPublicKey: row.publicKey,
        slot: row.slot,
        endpoint,
        origin
    });

    await up(row.publicTarget, ownerId, {
        tunnelId: id,
        end: "public",
        config: publicConfig,
        networks: [row.publicTarget.proxyNetwork],
        listenPort: row.listenPort
    });
    await up(app.target, ownerId, {
        tunnelId: id,
        end: "nat",
        config: natConfig,
        networks: await connectorNetworks(app.id, app.target.proxyNetwork)
    });
    await publishRoutes(ownerId, row.publicTarget);
}

async function up(
    target: TunnelRow["application"]["target"],
    ownerId: string,
    input: wg.EndSpecInput
): Promise<void> {
    const ports = await getPorts(target, ownerId);
    try {
        await ports.composeUp(wg.endSpec(input));
    } finally {
        await ports.dispose();
    }
}

/**
 * Stop both ends and rewrite the public edge's routes from the database (the
 * caller has already marked the tunnel paused, so its hostname drops out). Each
 * step is tried on its own, so one unreachable server never strands the other.
 * Returns the names of the servers where something could not be cleaned up.
 */
async function takeDown(ownerId: string, id: string, row: TunnelRow): Promise<string[]> {
    const left: string[] = [];
    for (const [target, end] of [
        [row.publicTarget, "public"],
        [row.application.target, "nat"]
    ] as const) {
        const ports = await getPorts(target, ownerId).catch(() => null);
        if (!ports) {
            left.push(target.name);
            continue;
        }
        try {
            await ports.composeDown(wg.endNames(id, end).project);
        } catch (error) {
            // An end that never started has nothing to take down, and the engine
            // says so as a failure. Only a container that is still there is left.
            if (!(await endGone(ports, id, end))) {
                console.error(`[tunnels] stopping the ${end} end failed`, error);
                left.push(target.name);
            }
        } finally {
            await ports.dispose();
        }
    }
    try {
        await publishRoutes(ownerId, row.publicTarget);
    } catch (error) {
        console.error("[tunnels] rewriting the edge routes failed", error);
        left.push(row.publicTarget.name);
    }
    return left;
}

/** Whether neither container of one end exists on its server any more. */
async function endGone(
    ports: Awaited<ReturnType<typeof getPorts>>,
    id: string,
    end: "public" | "nat"
): Promise<boolean> {
    const names = wg.endNames(id, end);
    for (const name of [names.helper, names.wireguard]) {
        // Only the engine's "no such container" counts as gone - a 404 from the
        // daemon, or `docker inspect` exiting 1 over SSH. Any other failure to ask
        // means it may well still be there.
        const missing = await ports.inspect(name).then(
            () => false,
            (error: unknown) =>
                /\(404\)|exited with code 1$|no such (object|container)/i.test(String(error))
        );
        if (!missing) return false;
    }
    return true;
}

/** Rewrite the tunnel routes file on one public server's edge from the database. */
async function publishRoutes(ownerId: string, target: TunnelRow["publicTarget"]): Promise<void> {
    const rows = await prisma.wireguardTunnel.findMany({
        where: { publicTargetId: target.id, paused: false },
        select: { id: true, hostname: true },
        orderBy: { createdAt: "asc" },
        take: 500
    });
    const yaml = wg.renderTunnelRoutes(rows);
    if (target.kind === "local" || !target.hostId) {
        await writeDynamicFile(wg.TUNNEL_ROUTE_FILE, yaml);
        return;
    }
    const connection = await getHostConnection(target.hostId, ownerId);
    await new RemoteRouter({
        address: connection.address,
        port: connection.port,
        username: connection.username,
        auth: connection.auth,
        hostKey: connection.hostKey
    }).pushFile(wg.TUNNEL_ROUTE_FILE, yaml);
}

/**
 * A public server that has never had anything deployed to it has no edge yet, and a
 * route file there is read by nobody. Set it up the same way the Servers screen
 * does - nothing runs there to interrupt. An edge that runs but does not read the
 * pushed directory is the operator's to repair (setting it up again stops what it
 * serves for a moment), so that is refused with the reason instead.
 */
async function ensureEdge(hostId: string, ownerId: string, proxyNetwork: string): Promise<void> {
    const { readServerEdge, prepareServerEdge, withSetupLock } = await import(
        "@/lib/deploy/server-edge"
    );
    const edge = await readServerEdge(hostId, ownerId);
    if (edge.error) throw new TunnelRefusal("unreachable");
    if (!edge.traefik) {
        await withSetupLock(hostId, () => prepareServerEdge(hostId, ownerId, proxyNetwork));
        return;
    }
    if (!edge.pushable) throw new TunnelRefusal("edge");
}
