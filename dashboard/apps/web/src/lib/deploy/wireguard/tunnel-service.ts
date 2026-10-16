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
import { loadEnv } from "@polaris/config";
import { serviceName } from "@polaris/deploy";
import { getPorts } from "@/lib/deploy/runtime";
import { getPublicIp } from "@/lib/domain-service";
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
    | "edge";

export class TunnelRefusal extends Error {
    public constructor(public readonly code: TunnelRefusalCode) {
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

const TARGET_SELECT = { id: true, name: true, kind: true, hostId: true, runtime: true, proxyNetwork: true } as const;

/** Encrypt a private key for storage. */
export function sealKey(privateKey: string, masterKey = loadEnv().POLARIS_MASTER_KEY): string {
    const blob = encryptSecret(privateKey, masterKey);
    return JSON.stringify({ c: blob.ciphertext.toString("base64"), n: blob.nonce.toString("base64"), k: blob.keyId });
}

/** Decrypt a stored private key. */
export function openKey(sealed: string, masterKey = loadEnv().POLARIS_MASTER_KEY): string {
    const { c, n, k } = JSON.parse(sealed) as { c: string; n: string; k: string };
    return decryptSecret({ ciphertext: Buffer.from(c, "base64"), nonce: Buffer.from(n, "base64"), keyId: k }, masterKey);
}

/** Lowercase, no scheme, no trailing dot or slash. */
export function normalizeHostname(value: string): string {
    return value
        .trim()
        .toLowerCase()
        .replace(/^https?:\/\//, "")
        .replace(/[/.]+$/, "");
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
            select: { id: true, name: true, targetId: true, environment: { select: { project: { select: { name: true } } } } },
            orderBy: { name: "asc" },
            take: 500
        })
    ]);
    return {
        servers: targets.map((target) => ({ id: target.id, name: target.name, local: target.kind === "local" })),
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
            publicTarget: { select: { id: true, name: true, kind: true, host: { select: { address: true } } } },
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
    const localIp = rows.some((row) => row.publicTarget.kind === "local") ? await getPublicIp() : null;
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
        endpointHost: row.publicTarget.kind === "local" ? localIp : (row.publicTarget.host?.address ?? null),
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
        prisma.deployTarget.findFirst({ where: { id: input.publicServerId, ownerId }, select: { id: true } }),
        prisma.application.findFirst({
            where: { id: input.serviceId, environment: { project: { ownerId } } },
            select: { id: true, targetId: true }
        })
    ]);
    if (!target) throw new TunnelRefusal("noServer");
    if (!app) throw new TunnelRefusal("noService");
    if (app.targetId === target.id) throw new TunnelRefusal("sameServer");
    const [taken, domain] = await Promise.all([
        prisma.wireguardTunnel.findUnique({ where: { hostname }, select: { id: true } }),
        prisma.domain.findFirst({ where: { hostname }, select: { id: true } }).catch(() => null)
    ]);
    if (taken || domain) throw new TunnelRefusal("hostnameTaken");

    const publicPair = wg.generateKeyPair();
    const natPair = wg.generateKeyPair();
    // Two creates at once can pick the same slot or port; the unique indexes refuse
    // the second, and it picks again.
    let created: { id: string } | null = null;
    for (let attempt = 0; attempt < 3 && !created; attempt += 1) {
        const [slots, ports] = await Promise.all([
            prisma.wireguardTunnel.findMany({ where: { ownerId }, select: { slot: true } }),
            prisma.wireguardTunnel.findMany({ where: { publicTargetId: target.id }, select: { listenPort: true } })
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
            const again = await prisma.wireguardTunnel.findUnique({ where: { hostname }, select: { id: true } });
            if (again) throw new TunnelRefusal("hostnameTaken");
        }
    }
    if (!created) throw new TunnelRefusal("full");
    try {
        await bringUp(ownerId, created.id);
    } catch (error) {
        // Half a tunnel is worse than none: take back what started and the row.
        await removeTunnel(ownerId, created.id).catch(() => undefined);
        throw error;
    }
    return created;
}

/** Stop both ends and take the hostname off the edge, keeping keys and settings. */
export async function setTunnelPaused(ownerId: string, id: string, paused: boolean): Promise<void> {
    const row = await prisma.wireguardTunnel.findFirst({ where: { id, ownerId }, select: { id: true, paused: true } });
    if (!row) throw new TunnelRefusal("notFound");
    if (row.paused === paused) return;
    await prisma.wireguardTunnel.update({ where: { id }, data: { paused } });
    if (paused) await takeDown(ownerId, id);
    else await bringUp(ownerId, id);
}

/** Remove both ends, the route and the row. */
export async function removeTunnel(ownerId: string, id: string): Promise<void> {
    const row = await loadTunnel(ownerId, id);
    await takeDown(ownerId, id, row);
    await prisma.wireguardTunnel.deleteMany({ where: { id, ownerId } });
    await publishRoutes(ownerId, row.publicTarget);
}

/** Read the live state from whichever end answers, the public one first. */
export async function readTunnelStatus(ownerId: string, id: string, now = Date.now()): Promise<TunnelStatus> {
    const row = await loadTunnel(ownerId, id);
    if (row.paused) return { health: "paused", lastHandshake: 0, rxBytes: 0, txBytes: 0 };
    const ends = [
        { target: row.publicTarget, helper: wg.endNames(id, "public").helper, peer: row.peerPublicKey },
        { target: row.application.target, helper: wg.endNames(id, "nat").helper, peer: row.publicKey }
    ];
    for (const end of ends) {
        const ports = await getPorts(end.target, ownerId).catch(() => null);
        if (!ports) continue;
        try {
            const result = await ports.runIn(end.helper, wg.statusCommand());
            if (result.code !== 0) continue;
            const peer = wg.parseDeviceState(result.output).find((one) => one.publicKeyHex === wg.keyToHex(end.peer));
            if (!peer) continue;
            return {
                health: wg.tunnelHealth(peer.lastHandshake, Math.floor(now / 1000)),
                lastHandshake: peer.lastHandshake,
                rxBytes: peer.rxBytes,
                txBytes: peer.txBytes
            };
        } catch {
            // The other end may still answer.
        } finally {
            await ports.dispose();
        }
    }
    return { health: "unknown", lastHandshake: 0, rxBytes: 0, txBytes: 0 };
}

type TunnelRow = Awaited<ReturnType<typeof loadTunnel>>;

async function loadTunnel(ownerId: string, id: string) {
    const row = await prisma.wireguardTunnel.findFirst({
        where: { id, ownerId },
        select: {
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
        }
    });
    if (!row) throw new TunnelRefusal("notFound");
    return row;
}

/** Start both ends from the stored keys and put the hostname on the public edge. */
async function bringUp(ownerId: string, id: string): Promise<void> {
    const row = await loadTunnel(ownerId, id);
    const host = row.publicTarget.kind === "local" ? await getPublicIp() : (row.publicTarget.host?.address ?? null);
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

async function up(target: TunnelRow["application"]["target"], ownerId: string, input: wg.EndSpecInput): Promise<void> {
    const ports = await getPorts(target, ownerId);
    try {
        await ports.composeUp(wg.endSpec(input));
    } finally {
        await ports.dispose();
    }
}

/** Stop both ends (best effort each, so one unreachable server never strands the
 *  other) and drop the route. */
async function takeDown(ownerId: string, id: string, loaded?: TunnelRow): Promise<void> {
    const row = loaded ?? (await loadTunnel(ownerId, id));
    for (const [target, end] of [
        [row.publicTarget, "public"],
        [row.application.target, "nat"]
    ] as const) {
        const ports = await getPorts(target, ownerId).catch(() => null);
        if (!ports) continue;
        try {
            await ports.composeDown(wg.endNames(id, end).project).catch(() => undefined);
        } finally {
            await ports.dispose();
        }
    }
    if (!loaded) await publishRoutes(ownerId, row.publicTarget);
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
    const { readServerEdge, prepareServerEdge, withSetupLock } = await import("@/lib/deploy/server-edge");
    const edge = await readServerEdge(hostId, ownerId);
    if (edge.error) throw new TunnelRefusal("unreachable");
    if (!edge.traefik) {
        await withSetupLock(hostId, () => prepareServerEdge(hostId, ownerId, proxyNetwork));
        return;
    }
    if (!edge.pushable) throw new TunnelRefusal("edge");
}
