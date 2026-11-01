/**
 * Private networks: creating them, the gateway that carries each one into the
 * VPN, and where each stands.
 *
 * A server has one gateway, however many networks it serves: a container that
 * offers all of that server's subnets as one VPN device. The stored networks are
 * the truth and the gateway is brought in line with them, so a server that was
 * unreachable when something changed is repaired by Retry and nothing is lost.
 *
 * Server-only.
 */

import * as vpn from "./service";
import * as rules from "./settings";
import { prisma } from "@polaris/db";
import * as networks from "./networks";
import { getCapabilities } from "@polaris/config";
import type { RuntimePorts } from "@polaris/deploy";
import { GATEWAY_PROJECT } from "@/lib/polaris-parts";
import { randomBytes, randomUUID } from "node:crypto";
import { openText, sealText } from "@/lib/tls/managed-certificates";

/** Who pressed the button, for the key a gateway signs in with. */
interface Actor {
    readonly id: string;
    readonly name: string;
    readonly email: string;
}

/** Where a network's way in stands, from what the VPN and the server report. */
export type GatewayState = "waiting" | "offline" | "unapproved" | "online";

/** A network as the screen shows it. The Wi-Fi and the router's setup are an
 *  administrator's, and absent for anybody else. */
export interface NetworkView {
    readonly id: string;
    readonly name: string;
    readonly cidr: string;
    readonly routerAddress: string;
    readonly access: networks.PrivateNetwork["access"];
    readonly internet: boolean;
    readonly serverName: string | null;
    readonly gateway: GatewayState;
    /** Whether the gateway reaches the router; null when it was not asked. */
    readonly routerReachable: boolean | null;
    readonly setup: {
        readonly ssid: string;
        readonly wifiPassword: string | null;
        readonly dhcp: { readonly first: string; readonly last: string };
        readonly bridge: string;
        readonly openWrt: string | null;
    } | null;
}

export interface NetworkServer {
    readonly id: string;
    readonly name: string;
}

/** Whether this edition can start a gateway at all. */
export function canRunGateways(): boolean {
    return getCapabilities().deploy;
}

function requireFull(): void {
    if (!canRunGateways()) throw new vpn.VpnRefusal("limited");
}

/** Refuse while the control server is off, before anything is stored that the
 *  access policy could not carry. */
async function requireRunning(): Promise<void> {
    await vpn.allNodes();
}

/** Changes run one at a time: each reads, changes and writes the whole list. */
let queue: Promise<unknown> = Promise.resolve();
function serialized<T>(work: () => Promise<T>): Promise<T> {
    const run = queue.then(work, work);
    queue = run.catch(() => undefined);
    return run;
}

/** Bring one server's gateway in line with the networks it serves; with none left,
 *  take it down and off the VPN. What the VPN side decides goes first, so a server
 *  that cannot be reached still loses the access it should lose. */
async function syncGateway(
    actor: Actor,
    network: networks.PrivateNetwork,
    all: readonly networks.PrivateNetwork[]
): Promise<void> {
    const routes = all.filter((one) => one.targetId === network.targetId).map(({ cidr }) => cidr);
    const name = networks.gatewayName(network.targetId);
    const known = (await vpn.allNodes()).filter((node) =>
        networks.isGatewayNode(node, name, rules.POLARIS_TAG)
    );
    if (routes.length > 0) {
        for (const node of known) {
            const kept = node.approvedRoutes.filter((route) => routes.includes(route));
            if (kept.length < node.approvedRoutes.length) {
                await vpn.approveGatewayRoutes(node.id, kept);
            }
        }
        const { loginServer, authKey } = await vpn.gatewayKey(actor);
        const generation = known.length > 0 ? null : randomUUID();
        await vpn.onNetworkServer(network, (ports) =>
            ports.composeUp(
                networks.gatewaySpec({ name, loginServer, routes, authKey, generation })
            )
        );
        return;
    }
    try {
        for (const node of known) await vpn.removeGatewayNode(node.id);
    } finally {
        await vpn.onNetworkServer(network, (ports) => ports.composeDown(GATEWAY_PROJECT));
    }
}

/** Carry the stored networks to the VPN: the access policy, then the gateway. */
async function applyNetworks(
    actor: Actor,
    network: networks.PrivateNetwork,
    all: readonly networks.PrivateNetwork[]
): Promise<void> {
    await vpn.applyNetworkAccess();
    await syncGateway(actor, network, all);
}

function wifiPassword(): string {
    // No 0/O or 1/l: this is read off a screen and typed into a phone.
    const alphabet = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    return [...randomBytes(20)].map((byte) => alphabet[byte % alphabet.length]).join("");
}

/** A saved network, and why it is not carried to the VPN yet, if it is not. */
export interface CreatedNetwork {
    readonly network: networks.PrivateNetwork;
    readonly problem: vpn.VpnRefusal | null;
}

/** Add a network. It is kept even when its server cannot be reached, so the screen
 *  can say so and offer Retry rather than losing what was typed. */
export async function createNetwork(
    actor: Actor,
    input: networks.NetworkInput
): Promise<CreatedNetwork> {
    requireFull();
    return serialized(async () => {
        await requireRunning();
        const stored = await vpn.storedNetworks();
        if (stored.length >= networks.MAX_NETWORKS) throw new vpn.VpnRefusal("tooMany");
        if (stored.some((one) => networks.cidrsOverlap(one.cidr, input.cidr))) {
            throw new vpn.VpnRefusal("subnetTaken");
        }
        const target = await prisma.deployTarget.findFirst({
            where: { id: input.targetId, ownerId: actor.id, status: "active" },
            select: { id: true, ownerId: true }
        });
        if (!target) throw new vpn.VpnRefusal("noServer");
        const network: networks.PrivateNetwork = {
            ...input,
            id: randomUUID(),
            targetOwnerId: target.ownerId,
            wifiPassword: sealText(wifiPassword()),
            createdAt: new Date().toISOString()
        };
        const next = [...stored, network];
        await vpn.saveNetworks(next);
        const problem = await applyNetworks(actor, network, next).then(() => null, gatewayRefusal);
        return { network, problem };
    });
}

function gatewayRefusal(error: unknown): vpn.VpnRefusal {
    if (error instanceof vpn.VpnRefusal) return error;
    console.error("polaris: a VPN gateway was not brought up to date:", error);
    return new vpn.VpnRefusal("gatewayFailed");
}

/** Change what a network is called and who it is for. */
export async function updateNetwork(change: networks.NetworkChange): Promise<void> {
    await serialized(async () => {
        await requireRunning();
        const stored = await vpn.storedNetworks();
        if (!stored.some((one) => one.id === change.id)) throw new vpn.VpnRefusal("notFound");
        await vpn.saveNetworks(
            stored.map((one) => (one.id === change.id ? { ...one, ...change } : one))
        );
        await vpn.applyNetworkAccess();
    });
}

/** Carry a network to the VPN again, after its server came back. */
export async function retryGateway(actor: Actor, id: string): Promise<void> {
    requireFull();
    await serialized(async () => {
        const stored = await vpn.storedNetworks();
        const network = stored.find((one) => one.id === id);
        if (!network) throw new vpn.VpnRefusal("notFound");
        await applyNetworks(actor, network, stored).catch((error: unknown) => {
            throw gatewayRefusal(error);
        });
    });
}

/**
 * Delete a network. Access ends first and survives a dead server: the policy and
 * the record go even if the gateway cannot be told, and its device is removed from
 * the VPN side, so nothing it still offers is reachable.
 */
export async function removeNetwork(actor: Actor, id: string): Promise<void> {
    await serialized(async () => {
        await requireRunning();
        const stored = await vpn.storedNetworks();
        const network = stored.find((one) => one.id === id);
        if (!network) throw new vpn.VpnRefusal("notFound");
        const next = stored.filter((one) => one.id !== id);
        await vpn.saveNetworks(next);
        const logged = (error: unknown) =>
            console.error("polaris: a removed network was not cleared from the VPN:", error);
        await vpn.applyNetworkAccess().catch(logged);
        await syncGateway(actor, network, next).catch(logged);
    });
}

/** Whether the gateway's container answers from the router's address. */
async function reaches(ports: RuntimePorts, address: string): Promise<boolean> {
    const result = await ports
        .runIn(networks.GATEWAY_SERVICE, ["ping", "-c", "1", "-W", "2", address])
        .catch(() => null);
    return result?.code === 0;
}

/** The ids of the networks whose router answers, over one connection per server.
 *  One at a time: a server limits how many commands a connection runs at once. */
async function answeringRouters(list: readonly networks.PrivateNetwork[]): Promise<Set<string>> {
    const servers = list.filter(
        (one, index) => list.findIndex(({ targetId }) => targetId === one.targetId) === index
    );
    const answers = await Promise.all(
        servers.map((server) =>
            vpn
                .onNetworkServer(server, async (ports) => {
                    const answering: string[] = [];
                    for (const network of list) {
                        if (network.targetId !== server.targetId) continue;
                        if (await reaches(ports, network.routerAddress)) answering.push(network.id);
                    }
                    return answering;
                })
                .catch(() => [])
        )
    );
    return new Set(answers.flat());
}

function stateOf(
    node: { readonly online: boolean; readonly approvedRoutes: readonly string[] } | undefined,
    cidr: string
): GatewayState {
    if (!node) return "waiting";
    if (!node.online) return "offline";
    return node.approvedRoutes.includes(cidr) ? "online" : "unapproved";
}

/**
 * The networks a viewer may see, and where each stands. Reading is also what
 * approves a gateway's routes: a gateway offers them some seconds after it starts,
 * and an administrator already asked for exactly these when creating the network.
 */
export async function listNetworks(viewer: rules.VpnViewer): Promise<NetworkView[]> {
    const stored = await vpn.storedNetworks();
    const visible = stored.filter((one) => viewer.isAdmin || one.access === "everyone");
    if (visible.length === 0) return [];
    const nodes = await vpn.allNodes();
    const gateways = new Map(
        [...new Set(stored.map((one) => one.targetId))].map((targetId) => {
            const name = networks.gatewayName(targetId);
            const found = nodes.filter((node) =>
                networks.isGatewayNode(node, name, rules.POLARIS_TAG)
            );
            return [targetId, found.find((node) => node.online) ?? found[0]] as const;
        })
    );
    if (viewer.isAdmin) {
        for (const [targetId, node] of gateways) {
            if (!node) continue;
            const offered = new Set(node.availableRoutes);
            const wanted = stored
                .filter((one) => one.targetId === targetId && offered.has(one.cidr))
                .map(({ cidr }) => cidr);
            const same =
                wanted.length === node.approvedRoutes.length &&
                wanted.every((route) => node.approvedRoutes.includes(route));
            if (same) continue;
            await vpn.approveGatewayRoutes(node.id, wanted);
            gateways.set(targetId, { ...node, approvedRoutes: wanted });
        }
    }
    const servers = await prisma.deployTarget.findMany({
        where: { id: { in: visible.map((one) => one.targetId) } },
        select: { id: true, name: true }
    });
    const names = new Map(servers.map((server) => [server.id, server.name]));
    const stateFor = (network: networks.PrivateNetwork) =>
        stateOf(gateways.get(network.targetId), network.cidr);
    const answering = await answeringRouters(
        viewer.isAdmin ? visible.filter((one) => stateFor(one) === "online") : []
    );
    return visible.map((network) => {
        const gateway = stateFor(network);
        const password = viewer.isAdmin ? openText(network.wifiPassword) : null;
        return {
            id: network.id,
            name: network.name,
            cidr: network.cidr,
            routerAddress: network.routerAddress,
            access: network.access,
            internet: network.internet,
            serverName: names.get(network.targetId) ?? null,
            gateway,
            routerReachable:
                viewer.isAdmin && gateway === "online" ? answering.has(network.id) : null,
            setup: viewer.isAdmin
                ? {
                      ssid: network.ssid,
                      wifiPassword: password,
                      dhcp: networks.dhcpRange(network.cidr),
                      bridge: networks.bridgeName(network.id),
                      openWrt: password ? networks.renderOpenWrtSetup(network, password) : null
                  }
                : null
        };
    });
}

/** The servers a gateway can run on: an administrator's own, active ones. */
export async function networkServers(ownerId: string): Promise<NetworkServer[]> {
    if (!canRunGateways()) return [];
    return prisma.deployTarget.findMany({
        where: { ownerId, status: "active" },
        select: { id: true, name: true },
        orderBy: { name: "asc" },
        take: 200
    });
}
