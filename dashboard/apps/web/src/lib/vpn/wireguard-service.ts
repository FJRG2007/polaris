/**
 * Nodes, who may use them, and each person's devices. A node is one of an
 * administrator's machines, reached over the root login Polaris already holds, so
 * nothing is installed by hand. Limits are enforced on the node itself: a device whose
 * owner lost access is taken out of the node's peer list on the next pass.
 */

import * as wg from "./wireguard";
import { prisma } from "@polaris/db";
import { generateKeyPairSync } from "node:crypto";
import { edgeLauncher } from "@/lib/deploy/server-edge";
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

async function syncNode(node: NodeRow): Promise<void> {
    const connection = await connectionOf(node.hostId);
    await runAsRoot(connection, wg.renderPeerSync(planOf(node), await allowedPeers(node.id)));
}

/** Install or update a node, and keep the key it answers with. */
async function deployNode(node: NodeRow): Promise<NodeRow> {
    const connection = await connectionOf(node.hostId);
    const said = await runAsRoot(
        connection,
        wg.renderNodeApply(planOf(node), await allowedPeers(node.id))
    ).catch((error: unknown) => {
        if (error instanceof WireGuardRefusal) throw error;
        console.error("polaris: a VPN node could not be set up:", error);
        throw new WireGuardRefusal("unreachable");
    });
    const publicKey = /^public-key=(\S+)$/m.exec(said)?.[1];
    if (!publicKey || !wg.isWireGuardKey(publicKey)) throw new WireGuardRefusal("unreachable");
    return prisma.vpnNode.update({ where: { id: node.id }, data: { publicKey } });
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
        await runAsRoot(await connectionOf(node.hostId), wg.NODE_REMOVE);
    } catch (error) {
        console.error("polaris: a VPN node could not be taken down:", error);
        if (!anyway) throw new WireGuardRefusal("unreachable");
    }
    await prisma.vpnNode.delete({ where: { id } });
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

function newKeyPair(): { privateKey: string; publicKey: string } {
    const { publicKey, privateKey } = generateKeyPairSync("x25519");
    const encode = (value: string | undefined) => Buffer.from(value ?? "", "base64url").toString("base64");
    return {
        privateKey: encode(privateKey.export({ format: "jwk" }).d),
        publicKey: encode(publicKey.export({ format: "jwk" }).x)
    };
}

/** The nodes a person may pick from. */
export async function nodesFor(user: { id: string; isAdmin: boolean }) {
    const access = await accessOf(user);
    if (!access) return [];
    const nodes = await prisma.vpnNode.findMany({
        where: { publicKey: { not: null } },
        orderBy: { name: "asc" },
        take: wg.MAX_NODES,
        select: { id: true, name: true, exit: true }
    });
    return nodes.filter(({ id }) => wg.mayUseNode(access, id));
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
export async function addDevice(
    user: { id: string; isAdmin: boolean },
    input: { nodeId: string; name: string }
): Promise<{ config: string; fileName: string }> {
    const access = await accessOf(user);
    if (!access || wg.accessStanding(access, new Date()) !== "active") {
        throw new WireGuardRefusal("noAccess");
    }
    if (!wg.mayUseNode(access, input.nodeId)) throw new WireGuardRefusal("noAccess");
    const owned = await prisma.vpnPeer.count({ where: { userId: user.id } });
    if (owned >= access.deviceLimit) throw new WireGuardRefusal("deviceLimit");
    const node = await nodeRow(input.nodeId);
    if (!node?.publicKey) throw new WireGuardRefusal("nodeNotReady");
    const keys = newKeyPair();
    const peer = await claimAddress(node.id, user.id, input.name, keys.publicKey);
    await syncNode(node).catch(async (error: unknown) => {
        await prisma.vpnPeer.delete({ where: { id: peer.id } });
        console.error("polaris: a VPN device could not be added:", error);
        throw new WireGuardRefusal("unreachable");
    });
    return {
        config: wg.renderDeviceConfig({
            privateKey: keys.privateKey,
            address: wg.deviceAddress(node.subnetIndex, peer.hostIndex),
            nodePublicKey: node.publicKey,
            endpoint: node.endpoint,
            port: node.port
        }),
        fileName: `${input.name.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "polaris"}.conf`
    };
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
        try {
            const connection = await connectionOf(node.hostId);
            const counters = wg.parsePeerCounters(await runAsRoot(connection, wg.NODE_READ));
            await recordCounters(node.id, counters);
            await syncNode(node);
        } catch (error) {
            console.error("polaris: a VPN node could not be read:", error);
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
