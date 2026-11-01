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
import { getPorts, type TargetRow } from "@/lib/deploy/runtime";
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
        readonly dhcp: { readonly start: number; readonly limit: number };
        readonly openWrt: string | null;
    } | null;
}

export interface NetworkServer {
    readonly id: string;
    readonly name: string;
}

function requireFull(): void {
    if (!getCapabilities().deploy) throw new vpn.VpnRefusal("limited");
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

async function targetOf(network: {
    readonly targetId: string;
    readonly targetOwnerId: string;
}): Promise<TargetRow | null> {
    return prisma.deployTarget.findFirst({
        where: { id: network.targetId, ownerId: network.targetOwnerId },
        select: { id: true, kind: true, hostId: true, runtime: true, proxyNetwork: true }
    });
}

/** Run `work` against a network's server, closing the connection after. */
async function onServer<T>(
    network: networks.PrivateNetwork,
    work: (ports: RuntimePorts) => Promise<T>
): Promise<T> {
    const target = await targetOf(network);
    if (!target) throw new vpn.VpnRefusal("noServer");
    const ports = await getPorts(target, network.targetOwnerId);
    try {
        return await work(ports);
    } finally {
        await ports.dispose();
    }
}

/** Bring one server's gateway in line with the networks it serves; with none left,
 *  take it down and off the VPN. */
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
        const { loginServer, authKey } = await vpn.gatewayKey(actor);
        const generation = known.length > 0 ? null : randomUUID();
        await onServer(network, (ports) =>
            ports.composeUp(
                networks.gatewaySpec({ name, loginServer, routes, authKey, generation })
            )
        );
        return;
    }
    await onServer(network, (ports) => ports.composeDown(GATEWAY_PROJECT));
    for (const node of known) await vpn.removeGatewayNode(node.id);
}

function wifiPassword(): string {
    // No 0/O or 1/l: this is read off a screen and typed into a phone.
    const alphabet = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    return [...randomBytes(20)].map((byte) => alphabet[byte % alphabet.length]).join("");
}

/** Add a network. It is kept even when its server cannot be reached, so the screen
 *  can say so and offer Retry rather than losing what was typed. */
export async function createNetwork(
    actor: Actor,
    input: networks.NetworkInput
): Promise<networks.PrivateNetwork> {
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
        await vpn.applyNetworkAccess();
        await syncGateway(actor, network, next).catch(gatewayFailure);
        return network;
    });
}

function gatewayFailure(error: unknown): never {
    if (error instanceof vpn.VpnRefusal) throw error;
    console.error("polaris: a VPN gateway was not brought up to date:", error);
    throw new vpn.VpnRefusal("gatewayFailed");
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

/** Start a network's gateway again, after its server came back. */
export async function retryGateway(actor: Actor, id: string): Promise<void> {
    requireFull();
    await serialized(async () => {
        const stored = await vpn.storedNetworks();
        const network = stored.find((one) => one.id === id);
        if (!network) throw new vpn.VpnRefusal("notFound");
        await syncGateway(actor, network, stored).catch(gatewayFailure);
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
        await vpn.applyNetworkAccess();
        await syncGateway(actor, network, next).catch((error: unknown) =>
            console.error("polaris: a removed network's gateway was not updated:", error)
        );
    });
}

/** Whether the gateway's container answers from the router's address. */
async function reaches(ports: RuntimePorts, address: string): Promise<boolean> {
    const result = await ports
        .runIn(networks.GATEWAY_SERVICE, ["ping", "-c", "1", "-W", "2", address])
        .catch(() => null);
    return result?.code === 0;
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
    return Promise.all(
        visible.map(async (network) => {
            const gateway = stateOf(gateways.get(network.targetId), network.cidr);
            const routerReachable =
                viewer.isAdmin && gateway === "online"
                    ? await onServer(network, (ports) =>
                          reaches(ports, network.routerAddress)
                      ).catch(() => false)
                    : null;
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
                routerReachable,
                setup: viewer.isAdmin
                    ? {
                          ssid: network.ssid,
                          wifiPassword: password,
                          dhcp: networks.dhcpPool(network.cidr),
                          openWrt: password
                              ? networks.renderOpenWrtSetup(network, password)
                              : null
                      }
                    : null
            };
        })
    );
}

/** The servers a gateway can run on: an administrator's own, active ones. */
export async function networkServers(ownerId: string): Promise<NetworkServer[]> {
    if (!getCapabilities().deploy) return [];
    return prisma.deployTarget.findMany({
        where: { ownerId, status: "active" },
        select: { id: true, name: true },
        orderBy: { name: "asc" },
        take: 200
    });
}
