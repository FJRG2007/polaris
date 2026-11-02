/**
 * Nodes, who may use them, and each person's devices. A node is one of an
 * administrator's machines, reached over the root login Polaris already holds, so
 * nothing is installed by hand. Limits are enforced on the node itself: a device whose
 * owner lost access is taken out of the node's peer list on the next pass.
 */

import { lookup } from "node:dns/promises";
import { resolveGeo } from "@/lib/geo-service";
import * as wg from "./wireguard";
import { prisma } from "@polaris/db";
import { edgeHostnameTaken } from "@/lib/app-edge";
import { edgeLauncher } from "@/lib/deploy/server-edge";
import { isIP } from "node:net";
import { loadEnv } from "@polaris/config";
import * as proxy from "@/lib/vpn/browser-proxy";
import { proxyLogin, type ProxyLogin } from "@/lib/vpn/browser-proxy-login";
import { remoteClearScript, remoteWriteScript } from "@/lib/deploy/router-remote";
import { decryptSecret, encryptSecret } from "@polaris/storage";
import { execCommand, openSshClient } from "@polaris/ssh";
import { getSetting, setSetting } from "@/lib/setting-store";
import { getHostConnectionUnscoped, type HostConnection } from "@/lib/host-service";

/** Whether somebody with no access of their own may connect, and with how many devices. */
const OPEN_ACCESS_KEY = "vpn.openAccess";

export type WireGuardRefusalCode =
    | "noRoot"
    | "unreachable"
    | "unsupported"
    | "noAccess"
    | "deviceLimit"
    | "nodeFull"
    | "nodeNotReady"
    | "notFound"
    | "noSuchPerson"
    | "tooManyNodes"
    | "invalid";

/** A reason a screen can say in the reader's words. */
export class WireGuardRefusal extends Error {
    constructor(readonly code: WireGuardRefusalCode) {
        super(code);
        this.name = "WireGuardRefusal";
    }
}

async function runAsRoot(connection: HostConnection, script: string): Promise<string> {
    const client = await openSshClient({
        host: connection.address,
        port: connection.port,
        username: connection.username,
        auth: connection.auth,
        pinnedHostKey: connection.hostKey
    });
    try {
        let said = "";
        const result = await execCommand(client, edgeLauncher(connection.username !== "root"), {
            input: script,
            onStdout: (chunk) => {
                said += chunk.toString("utf8");
            }
        });
        if (result.code === 3) throw new WireGuardRefusal("unsupported");
        if (result.code !== 0) throw new Error(`The machine answered exit ${result.code}`);
        return said;
    } finally {
        client.end();
    }
}

async function connectionOf(hostId: string): Promise<HostConnection> {
    const connection = await getHostConnectionUnscoped(hostId);
    if (connection.username !== "root" && !connection.sudo) throw new WireGuardRefusal("noRoot");
    return connection;
}

const PROXY_EDGE_FILE = "polaris-vpn-proxy.yml";
/** A peer list changes in moments; setting a machine up may install packages. */
const SYNC_WAIT_MS = 60_000;
const DEPLOY_WAIT_MS = 10 * 60_000;

const PEER_FIELDS = { id: true, userId: true, publicKey: true, hostIndex: true } as const;

type NodeRow = NonNullable<Awaited<ReturnType<typeof nodeRow>>>;

function nodeRow(id: string) {
    return prisma.vpnNode.findUnique({ where: { id } });
}

function planOf(node: NodeRow): wg.NodePlan {
    return { index: node.subnetIndex, port: node.port, exit: node.exit as wg.NodeExit };
}

export async function openAccess(): Promise<boolean> {
    return (await getSetting(OPEN_ACCESS_KEY)) === "true";
}

export async function setOpenAccess(open: boolean): Promise<void> {
    await setSetting(OPEN_ACCESS_KEY, open ? "true" : null);
}

const OPEN: Omit<wg.VpnAccess, "usedBytes"> = {
    nodes: [],
    deviceLimit: wg.DEFAULT_DEVICE_LIMIT,
    dataLimitGb: null,
    expiresAt: null,
    suspended: false
};

/** What a person may do, or null for no access. An administrator always has it, unless
 *  somebody gave them limits of their own. */
export async function accessOf(user: { id: string; isAdmin: boolean }): Promise<wg.VpnAccess | null> {
    const row = await prisma.vpnAccess.findUnique({ where: { userId: user.id } });
    if (row) {
        return {
            nodes: row.nodes,
            deviceLimit: row.deviceLimit,
            dataLimitGb: row.dataLimitGb,
            expiresAt: row.expiresAt,
            suspended: row.suspended,
            usedBytes: row.usedBytes
        };
    }
    return user.isAdmin || (await openAccess()) ? { ...OPEN, usedBytes: 0n } : null;
}

/** The peers a node should let in: every device whose owner is in good standing. */
async function allowedPeers(nodeId: string): Promise<{ publicKey: string; host: number }[]> {
    const peers = await prisma.vpnPeer.findMany({
        where: { nodeId },
        select: {
            publicKey: true,
            hostIndex: true,
            user: { select: { isAdmin: true, vpnAccess: true } }
        }
    });
    const open = await openAccess();
    const now = new Date();
    return peers.flatMap(({ publicKey, hostIndex, user }) => {
        const row = user.vpnAccess;
        if (!row) return user.isAdmin || open ? [{ publicKey, host: hostIndex }] : [];
        const allowed =
            wg.accessStanding(row, now) === "active" && wg.mayUseNode(row, nodeId);
        return allowed ? [{ publicKey, host: hostIndex }] : [];
    });
}

/**
 * One writer at a time on a node's peer list. The list is read inside the lock, so
 * the last write always holds every device already recorded and a device added
 * meanwhile cannot be overwritten by a list read before it existed. The transaction
 * only holds the lock: the work reads through its own connection.
 */
function onNode<T>(nodeId: string, timeout: number, work: () => Promise<T>): Promise<T> {
    return prisma.$transaction(
        async (tx) => {
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`polaris.vpn.node:${nodeId}`}))`;
            return work();
        },
        { timeout }
    );
}

async function syncNode(node: NodeRow): Promise<void> {
    const connection = await connectionOf(node.hostId);
    await onNode(node.id, SYNC_WAIT_MS, async () =>
        runAsRoot(connection, wg.renderPeerSync(planOf(node), await allowedPeers(node.id)))
    );
}

/** Install or update a node, and keep the key it answers with. */
async function deployNode(node: NodeRow): Promise<NodeRow> {
    const connection = await connectionOf(node.hostId);
    const said = await onNode(node.id, DEPLOY_WAIT_MS, async () =>
        runAsRoot(connection, wg.renderNodeApply(planOf(node), await allowedPeers(node.id)))
    ).catch((error: unknown) => {
        if (error instanceof WireGuardRefusal) throw error;
        console.error("polaris: a VPN node could not be set up:", error);
        throw new WireGuardRefusal("unreachable");
    });
    const publicKey = /^public-key=(\S+)$/m.exec(said)?.[1];
    if (!publicKey || !wg.isWireGuardKey(publicKey)) throw new WireGuardRefusal("unreachable");
    const proxyKey = /^proxy-key=(\S+)$/m.exec(said)?.[1];
    return prisma.vpnNode.update({
        where: { id: node.id },
        data: {
            publicKey,
            ...(proxyKey ? sealedProxyKey(proxyKey) : {}),
            proxyHost: await publishProxy(connection, node.endpoint)
        }
    });
}

function sealedProxyKey(key: string) {
    const blob = encryptSecret(key, loadEnv().POLARIS_MASTER_KEY);
    return { encryptedProxyKey: blob.ciphertext, proxyKeyNonce: blob.nonce, proxyKeyId: blob.keyId };
}

/**
 * Hand the edge the proxy's route, or take it back where it cannot be held. A browser
 * only accepts a certificate for a name, so a node reached by bare address has none; a
 * name something else already answers on would lose its site to this route, which
 * outranks it; and a machine with no edge has nothing to carry it. In all three the
 * tunnel still works from the desktop app, and the extension's row says why it cannot
 * be picked.
 */
async function publishProxy(connection: HostConnection, endpoint: string): Promise<string | null> {
    try {
        const usable =
            !isIP(endpoint) &&
            !(await edgeHostnameTaken(endpoint)) &&
            proxy.edgeIsReady(await runAsRoot(connection, proxy.PROXY_EDGE_PROBE));
        if (usable) {
            await runAsRoot(
                connection,
                remoteWriteScript(proxy.renderProxyEdge(endpoint), undefined, PROXY_EDGE_FILE)
            );
            return endpoint;
        }
        await runAsRoot(connection, remoteClearScript(PROXY_EDGE_FILE));
    } catch (error) {
        console.error("polaris: the VPN proxy route could not be published:", error);
    }
    return null;
}

/** A login for the extension. It lasts an hour; the extension asks again before that. */
export async function browserLogin(
    user: { id: string; isAdmin: boolean },
    nodeId: string
): Promise<ProxyLogin & { host: string; port: number }> {
    const access = await accessOf(user);
    if (!access || wg.accessStanding(access, new Date()) !== "active") {
        throw new WireGuardRefusal("noAccess");
    }
    if (!wg.mayUseNode(access, nodeId)) throw new WireGuardRefusal("noAccess");
    const node = await nodeRow(nodeId);
    if (!node?.proxyHost || !node.encryptedProxyKey || !node.proxyKeyNonce || !node.proxyKeyId) {
        throw new WireGuardRefusal("nodeNotReady");
    }
    const secret = decryptSecret(
        {
            ciphertext: Buffer.from(node.encryptedProxyKey),
            nonce: Buffer.from(node.proxyKeyNonce),
            keyId: node.proxyKeyId
        },
        loadEnv().POLARIS_MASTER_KEY
    );
    const login = proxyLogin(secret, user.id, Math.floor(Date.now() / 1000));
    return { ...login, host: node.proxyHost, port: 443 };
}

export async function listNodes() {
    return prisma.vpnNode.findMany({
        orderBy: { createdAt: "asc" },
        take: wg.MAX_NODES,
        select: {
            id: true,
            hostId: true,
            name: true,
            endpoint: true,
            port: true,
            exit: true,
            publicKey: true,
            _count: { select: { peers: true } }
        }
    });
}

/** Every number below the highest in use is reused before a new one is taken. */
function freeIndex(taken: readonly number[]): number {
    const used = new Set(taken);
    let index = 0;
    while (used.has(index)) index += 1;
    return index;
}

/** Whether a node stands on a machine this person owns: the root scripts changing or
 *  removing it run there, so that is who may ask for them. */
export async function ownsNode(nodeId: string, userId: string): Promise<boolean> {
    const node = await prisma.vpnNode.findFirst({
        where: { id: nodeId, host: { ownerId: userId } },
        select: { id: true }
    });
    return node !== null;
}

export async function addNode(input: wg.NodeInput): Promise<void> {
    const taken = await prisma.vpnNode.findMany({ select: { subnetIndex: true } });
    if (taken.length >= wg.MAX_NODES) throw new WireGuardRefusal("tooManyNodes");
    const node = await prisma.vpnNode.create({
        data: { ...input, subnetIndex: freeIndex(taken.map((row) => row.subnetIndex)) }
    });
    try {
        await deployNode(node);
    } catch (error) {
        await prisma.vpnNode.delete({ where: { id: node.id } });
        throw error;
    }
}

export async function updateNode(
    id: string,
    change: Pick<wg.NodeInput, "name" | "endpoint" | "port" | "exit">
): Promise<void> {
    const node = await prisma.vpnNode.update({ where: { id }, data: change });
    await deployNode(node);
}

/**
 * Take a node out. Its devices go with it: their configuration points nowhere now. A
 * machine that cannot be reached keeps running what it had, so that takes `anyway`,
 * which is how a machine that is gone for good stops being listed.
 */
export async function removeNode(id: string, anyway = false): Promise<void> {
    const node = await nodeRow(id);
    if (!node) return;
    try {
        const script = [remoteClearScript(PROXY_EDGE_FILE), wg.NODE_REMOVE].join("\n");
        await runAsRoot(await connectionOf(node.hostId), script);
    } catch (error) {
        console.error("polaris: a VPN node could not be taken down:", error);
        if (!anyway) throw new WireGuardRefusal("unreachable");
    }
    await prisma.vpnNode.delete({ where: { id } });
}

/** A machine leaving Polaris takes its node off first, while it can still be reached.
 *  False when it could not be: the row goes with the machine, the software stays. */
export async function removeNodeOn(hostId: string): Promise<boolean> {
    const node = await prisma.vpnNode.findUnique({ where: { hostId }, select: { id: true } });
    if (!node) return true;
    return removeNode(node.id).then(
        () => true,
        () => false
    );
}

export async function grantAccess(input: wg.AccessInput): Promise<void> {
    const { userId, ...access } = input;
    await prisma.vpnAccess.upsert({
        where: { userId },
        create: { userId, ...access },
        update: access
    });
    await syncNodesOf(userId);
}

/** Back to what somebody gets by default. Their devices stay; whether they still work
 *  depends on that default. */
export async function revokeAccess(userId: string): Promise<void> {
    await prisma.vpnAccess.deleteMany({ where: { userId } });
    await syncNodesOf(userId);
}

async function syncNodesOf(userId: string): Promise<void> {
    const nodes = await prisma.vpnNode.findMany({ where: { peers: { some: { userId } } } });
    await Promise.all(
        nodes.map((node) =>
            syncNode(node).catch((error: unknown) => {
                console.error("polaris: a VPN node could not be updated:", error);
            })
        )
    );
}

export async function listAccess() {
    const rows = await prisma.vpnAccess.findMany({
        orderBy: { createdAt: "desc" },
        take: 500,
        select: {
            userId: true,
            nodes: true,
            deviceLimit: true,
            dataLimitGb: true,
            expiresAt: true,
            suspended: true,
            usedBytes: true,
            user: { select: { name: true, email: true } }
        }
    });
    return rows.map(({ usedBytes, ...row }) => ({ ...row, usedBytes: usedBytes.toString() }));
}

/** The nodes a person may pick from. */
export async function nodesFor(user: { id: string; isAdmin: boolean }) {
    const access = await accessOf(user);
    if (!access) return [];
    const nodes = await prisma.vpnNode.findMany({
        where: { publicKey: { not: null } },
        orderBy: { name: "asc" },
        take: wg.MAX_NODES,
        select: { id: true, name: true, exit: true, proxyHost: true, country: true, city: true }
    });
    return nodes
        .filter(({ id }) => wg.mayUseNode(access, id))
        .map(({ proxyHost, ...node }) => ({ ...node, browser: proxyHost !== null }));
}

export async function devicesOf(userId: string) {
    const peers = await prisma.vpnPeer.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        take: 1000,
        select: {
            id: true,
            name: true,
            lastHandshake: true,
            received: true,
            sent: true,
            node: { select: { name: true, exit: true } }
        }
    });
    return peers.map(({ received, sent, ...peer }) => ({
        ...peer,
        received: received.toString(),
        sent: sent.toString()
    }));
}

/** Take the lowest free address. Two devices at once may pick the same one; the unique
 *  index refuses the second, which then looks again. */
async function claimAddress(nodeId: string, userId: string, name: string, publicKey: string) {
    for (let attempt = 0; ; attempt += 1) {
        const taken = await prisma.vpnPeer.findMany({ where: { nodeId }, select: { hostIndex: true } });
        const hostIndex = wg.freeHost(taken.map((row) => row.hostIndex));
        if (hostIndex === null) throw new WireGuardRefusal("nodeFull");
        try {
            return await prisma.vpnPeer.create({
                data: { nodeId, userId, name, publicKey, hostIndex }
            });
        } catch (error) {
            const conflict = (error as { code?: string }).code === "P2002";
            if (!conflict || attempt === 4) throw error;
        }
    }
}

/** Add a device, and hand back its configuration. This is the only time it exists: the
 *  private key is never stored. */
/** What an app of ours needs to bring the tunnel up. Its private key never leaves it. */
export interface ClientConnection {
    readonly deviceId: string;
    readonly address: string;
    readonly dns: readonly string[];
    readonly nodePublicKey: string;
    readonly endpoint: string;
    readonly port: number;
}

/**
 * A Polaris app connecting: it made its own key and sends only the public half. Asked
 * again with the same key it gets the same device, so reconnecting never uses up
 * the limit.
 */
export async function connectClient(
    user: { id: string; isAdmin: boolean },
    input: { nodeId: string; name: string; publicKey: string }
): Promise<ClientConnection> {
    if (!wg.isWireGuardKey(input.publicKey)) throw new WireGuardRefusal("notFound");
    const access = await accessOf(user);
    if (!access || wg.accessStanding(access, new Date()) !== "active") {
        throw new WireGuardRefusal("noAccess");
    }
    if (!wg.mayUseNode(access, input.nodeId)) throw new WireGuardRefusal("noAccess");
    const node = await nodeRow(input.nodeId);
    if (!node?.publicKey) throw new WireGuardRefusal("nodeNotReady");
    const answer = (id: string, hostIndex: number): ClientConnection => ({
        deviceId: id,
        address: wg.deviceAddress(node.subnetIndex, hostIndex),
        dns: wg.PUBLIC_DNS,
        nodePublicKey: node.publicKey as string,
        endpoint: node.endpoint,
        port: node.port
    });
    const known = await prisma.vpnPeer.findUnique({
        where: { publicKey: input.publicKey },
        select: { id: true, userId: true, hostIndex: true, nodeId: true }
    });
    if (known && known.userId !== user.id) throw new WireGuardRefusal("notFound");
    if (known?.nodeId === node.id) return answer(known.id, known.hostIndex);
    if (known) {
        // Moving to another node: the old one lets go before this one takes the key.
        await prisma.vpnPeer.delete({ where: { id: known.id } });
        const previous = await nodeRow(known.nodeId);
        if (previous) await syncNode(previous).catch(() => undefined);
    }
    const owned = await prisma.vpnPeer.count({ where: { userId: user.id } });
    if (owned >= access.deviceLimit) throw new WireGuardRefusal("deviceLimit");
    const peer = await claimAddress(node.id, user.id, input.name, input.publicKey);
    await syncNode(node).catch(async (error: unknown) => {
        await prisma.vpnPeer.delete({ where: { id: peer.id } });
        console.error("polaris: a VPN device could not be added:", error);
        throw new WireGuardRefusal("unreachable");
    });
    return answer(peer.id, peer.hostIndex);
}

export async function removeDevice(
    user: { id: string; isAdmin: boolean },
    id: string
): Promise<void> {
    const peer = await prisma.vpnPeer.findUnique({
        where: { id },
        select: { ...PEER_FIELDS, nodeId: true }
    });
    if (!peer || (peer.userId !== user.id && !user.isAdmin)) throw new WireGuardRefusal("notFound");
    await prisma.vpnPeer.delete({ where: { id } });
    const node = await nodeRow(peer.nodeId);
    if (node) await syncNode(node).catch(() => undefined);
}

/** Roll a monthly allowance over. */
function monthPassed(start: Date, now: Date): boolean {
    const next = new Date(start);
    next.setMonth(next.getMonth() + 1);
    return next <= now;
}

/**
 * Read every node's counters, add what grew to each person's month, and take out the
 * devices of anybody who ran out. On a schedule: run again it adds nothing new.
 */
/**
 * Where a server's traffic comes out, for the map. Asked of its own address, so
 * nobody has to say and servers that predate the map fill in by themselves. A
 * Tor exit changes all the time, so it has no place.
 */
async function placeNode(node: NodeRow): Promise<void> {
    if (node.country || node.exit === "tor") return;
    const ip = isIP(node.endpoint) ? node.endpoint : (await lookup(node.endpoint)).address;
    const { countryCode, city } = await resolveGeo(ip);
    if (!countryCode) return;
    await prisma.vpnNode.update({
        where: { id: node.id },
        data: { country: countryCode, city }
    });
}

export async function runVpnPass(): Promise<void> {
    const nodes = await prisma.vpnNode.findMany({ where: { publicKey: { not: null } } });
    const now = new Date();
    const accesses = await prisma.vpnAccess.findMany({ select: { userId: true, periodStart: true } });
    for (const { userId, periodStart } of accesses) {
        if (monthPassed(periodStart, now)) {
            await prisma.vpnAccess.update({
                where: { userId },
                data: { usedBytes: 0n, periodStart: now }
            });
        }
    }
    for (const node of nodes) {
        await placeNode(node).catch(() => undefined);
        try {
            const connection = await connectionOf(node.hostId);
            const counters = wg.parsePeerCounters(await runAsRoot(connection, wg.NODE_READ));
            await recordCounters(node.id, counters);
            await recordProxyUsage(node.id, await runAsRoot(connection, proxy.PROXY_USAGE_READ));
            await syncNode(node);
        } catch (error) {
            console.error("polaris: a VPN node could not be read:", error);
        }
    }
}

async function recordProxyUsage(nodeId: string, output: string): Promise<void> {
    const read = proxy.parseProxyUsage(output);
    const people = await prisma.user.findMany({
        where: { id: { in: read.map(({ userId }) => userId) } },
        select: { id: true }
    });
    const known = new Set(people.map(({ id }) => id));
    for (const { userId, used } of read) {
        if (!known.has(userId)) continue;
        const key = { nodeId_userId: { nodeId, userId } };
        const row = await prisma.vpnProxyUsage.findUnique({ where: key });
        const grew = wg.counterGrowth(used, row?.seen ?? 0n);
        await prisma.vpnProxyUsage.upsert({
            where: key,
            create: { nodeId, userId, seen: used },
            update: { seen: used }
        });
        if (grew > 0n) {
            await prisma.vpnAccess.updateMany({
                where: { userId },
                data: { usedBytes: { increment: grew } }
            });
        }
    }
}

async function recordCounters(nodeId: string, counters: readonly wg.PeerCounters[]): Promise<void> {
    const peers = await prisma.vpnPeer.findMany({
        where: { nodeId, publicKey: { in: counters.map(({ publicKey }) => publicKey) } },
        select: {
            id: true,
            userId: true,
            publicKey: true,
            received: true,
            sent: true,
            seenReceived: true,
            seenSent: true
        }
    });
    for (const peer of peers) {
        const read = counters.find(({ publicKey }) => publicKey === peer.publicKey);
        if (!read) continue;
        const received = wg.counterGrowth(read.received, peer.seenReceived);
        const sent = wg.counterGrowth(read.sent, peer.seenSent);
        await prisma.vpnPeer.update({
            where: { id: peer.id },
            data: {
                seenReceived: read.received,
                seenSent: read.sent,
                received: { increment: received },
                sent: { increment: sent },
                lastHandshake: read.lastHandshake
            }
        });
        if (received + sent > 0n) {
            await prisma.vpnAccess.updateMany({
                where: { userId: peer.userId },
                data: { usedBytes: { increment: received + sent } }
            });
        }
    }
}
