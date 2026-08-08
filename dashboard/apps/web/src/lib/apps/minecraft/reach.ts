/**
 * Whether a game server can be reached from outside, and what is still in the way.
 *
 * A deployed site and a game server look the same from inside Polaris and are not
 * the same at all from the internet: the site rides on 80 and 443, which the domain
 * setup already walks the operator through opening, while a game server answers on
 * a port of its own that nothing has ever asked anyone to open. So a server can be
 * running, its DNS perfect and its address printed on the page, and every player
 * still gets a timeout - which is exactly the failure this exists to name.
 *
 * Two things are needed and only one of them is Polaris's: the port has to reach
 * this machine, and Polaris has to know that it does. The second is the awkward
 * half. A probe from this box leaves and comes back through the operator's own
 * router, and plenty of them will not route their public address back inward, so a
 * silent probe proves nothing. It is therefore only ever used as positive evidence,
 * and the other proof is better: a player who joined from a public address is a
 * packet that arrived, and no router can fake that.
 */

import { connect } from "node:net";
import { prisma } from "@polaris/db";
import { isLanAddress } from "@/lib/host-address";
import type { ServerEnvironment } from "@polaris/core";
import { patchInstallConfig, readInstallConfig } from "@/lib/apps/install-config";
import { describeBlock, DEFAULT_PORT_BLOCKS, type PortBlocks, type PortPolicy } from "@/lib/apps/port-block";

/** One port a game server answers on, as the router has to be told it. */
export interface GamePort {
    readonly port: number;
    readonly protocol: "tcp" | "udp";
}

export interface GameReachAdvice {
    /** Nothing left to open, or nothing that can be judged as open. */
    readonly ok: boolean;
    /** True while the operator has something to do about it. */
    readonly actionable: boolean;
    readonly title: string;
    readonly detail: string;
    readonly steps: readonly string[];
    /** Whether a port forward is the thing missing, so the panel can offer the
     *  router walkthrough rather than a firewall instruction. */
    readonly forward: boolean;
}

/** How the ports read in a sentence: "TCP 25565" or "TCP 25565 and UDP 19132". */
export function describePorts(ports: readonly GamePort[]): string {
    const parts = ports.map((entry) => `${entry.protocol.toUpperCase()} ${entry.port}`);
    if (parts.length <= 1) return parts[0] ?? "its port";
    return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

/** The same sentence for the blocks these ports come from, which is what the
 *  range policy asks the operator to open: "TCP 25565-25664 and UDP 19132-19231". */
export function describeBlocksFor(ports: readonly GamePort[], blocks: PortBlocks): string {
    const used = (["tcp", "udp"] as const).filter((protocol) =>
        ports.some((entry) => entry.protocol === protocol)
    );
    const parts = used.map((protocol) => `${protocol.toUpperCase()} ${describeBlock(blocks[protocol])}`);
    if (parts.length <= 1) return parts[0] ?? "its range";
    return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

/**
 * What still has to happen for players outside the network to get in.
 *
 * Pure, and it says "confirmed" for one reason only: something arrived. Everything
 * else is phrased as unconfirmed rather than broken, because from in here the two
 * are indistinguishable and telling an operator their working server is down is
 * the more expensive mistake.
 */
export function gameReachAdvice(
    environment: ServerEnvironment,
    ports: readonly GamePort[],
    confirmed: boolean,
    lanIp: string | null = null,
    policy: PortPolicy = "per-port",
    blocks: PortBlocks = DEFAULT_PORT_BLOCKS
): GameReachAdvice {
    if (ports.length === 0) {
        return {
            ok: true,
            actionable: false,
            title: "No published port",
            detail: "This server publishes no port, so there is nothing to open.",
            steps: [],
            forward: false
        };
    }
    const named = describePorts(ports);
    if (confirmed) {
        return {
            ok: true,
            actionable: false,
            title: "Reachable from the internet",
            detail: `Players have connected to this server from outside the network, so ${named} reaches it.`,
            steps: [],
            forward: false
        };
    }
    if (environment === "home-cgnat") {
        return {
            ok: false,
            actionable: true,
            title: "This line cannot receive incoming connections",
            detail: `Your provider puts this connection behind carrier-grade NAT, so no forward can open ${named} - the public address is shared and it is not yours to open.`,
            steps: [
                "Ask your provider for a public IP address, which some offer on request.",
                "Until then the server is reachable on this network only, at its LAN address."
            ],
            forward: false
        };
    }
    if (environment === "home-nat") {
        const ranged = policy === "range";
        return {
            ok: false,
            actionable: true,
            title: `${named} has to be forwarded on your router`,
            detail: `The domain setup opens 80 and 443 for websites. ${named} is this server's own port, and nothing has opened it - until something does, players outside this network get a timeout.`,
            steps: [
                ranged
                    ? `Forward ${describeBlocksFor(ports, blocks)} to ${lanIp ?? "this server"} on your router. Polaris keeps every game server inside that range, so this is the last time it has to be opened.`
                    : `Forward ${named} to ${lanIp ?? "this server"} on your router.`,
                "Polaris marks this done by itself the first time somebody joins from outside."
            ],
            forward: true
        };
    }
    if (environment === "vps" || environment === "cloud") {
        return {
            ok: false,
            actionable: true,
            title: `${named} has to be allowed in your firewall`,
            detail: `This server holds its own public address, so nothing has to be forwarded - but the provider's firewall or security group has to let ${named} in.`,
            steps: [
                `Allow inbound ${named} in your provider's firewall or security group.`,
                "Polaris marks this done by itself the first time somebody joins from outside."
            ],
            forward: false
        };
    }
    return {
        ok: false,
        actionable: false,
        title: `${named} may not be reachable yet`,
        detail: `Polaris does not know where this machine sits on the network, so it cannot say what has to be opened for ${named}. Set it under Admin, Domains.`,
        steps: [],
        forward: false
    };
}

/** The ports a game install actually publishes, from what its deploy pinned. */
export async function gamePorts(applicationId: string | null): Promise<GamePort[]> {
    if (!applicationId) return [];
    const app = await prisma.application.findUnique({ where: { id: applicationId }, select: { sourceConfig: true } });
    if (!app) return [];
    let config: {
        hostPort?: unknown;
        hostProtocol?: unknown;
        extraPorts?: unknown;
    };
    try {
        config = JSON.parse(app.sourceConfig) as typeof config;
    } catch {
        return [];
    }
    const ports: GamePort[] = [];
    if (typeof config.hostPort === "number") {
        ports.push({ port: config.hostPort, protocol: config.hostProtocol === "udp" ? "udp" : "tcp" });
    }
    if (Array.isArray(config.extraPorts)) {
        for (const entry of config.extraPorts) {
            const extra = entry as { host?: unknown; protocol?: unknown };
            if (typeof extra.host === "number") {
                ports.push({ port: extra.host, protocol: extra.protocol === "udp" ? "udp" : "tcp" });
            }
        }
    }
    return ports;
}

/** Whether this install has ever been seen answering from outside. */
export function reachConfirmed(config: string | null | undefined): boolean {
    return typeof readInstallConfig(config).portReachableAt === "string";
}

/**
 * Record that the port demonstrably works, from a player who arrived on it.
 *
 * Only a public address counts. A join from the same LAN went nowhere near the
 * router, so treating it as proof would clear the warning for exactly the operator
 * who tested from their own desk - the one case where it means nothing.
 */
export async function noteReachedFrom(installedAppId: string, address: string): Promise<boolean> {
    if (isLanAddress(address)) return false;
    await patchInstallConfig(installedAppId, { portReachableAt: new Date().toISOString() });
    return true;
}

/** How long to wait on a port before calling the probe inconclusive. */
const PROBE_TIMEOUT_MS = 4000;

/**
 * Try to open the port from here, through the public address.
 *
 * Positive evidence only: a connection that completes went out to the public
 * address and came back in, which is the forward working. A refusal or a timeout
 * is reported as false and means nothing on its own - most routers do not loop
 * their own WAN address back inward. UDP is not probed at all, because an
 * unanswered UDP packet and a blocked one are the same silence.
 */
export function probeGamePort(host: string, port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = connect({ host, port, timeout: PROBE_TIMEOUT_MS });
        const settle = (reached: boolean): void => {
            socket.destroy();
            resolve(reached);
        };
        socket.once("connect", () => settle(true));
        socket.once("timeout", () => settle(false));
        socket.once("error", () => settle(false));
    });
}
