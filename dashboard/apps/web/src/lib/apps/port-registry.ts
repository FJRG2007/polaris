/**
 * Every host port Polaris has already spoken for.
 *
 * Two apps publishing the same port on the same machine is not a conflict Polaris
 * resolves - it is a container that fails to bind, discovered when the second one
 * is deployed - so the allocator has to know about every port before it hands out
 * the next. There are three ways a port gets claimed and until now only the first
 * was counted:
 *
 * - the port an app pinned, which is what a game server does so its players can
 *   type an address,
 * - the further ports a pinned app publishes (`extraPorts`) - a Java server that
 *   Bedrock clients join listens on a UDP port too, and two such servers were
 *   both being handed 19132,
 * - the port derived from an app's id for everything else (`hostPortForApp`),
 *   which lands anywhere in 20000-39999 and so can fall on a game's port.
 *
 * Instance-wide rather than per owner, deliberately: the machine is what a port
 * collides on, not the account, and the screens that ask an operator to open
 * these ports are already instance-wide for the same reason.
 *
 * Best effort on the third kind. An app that keeps its release history derives
 * its port from the release rather than the app, and enumerating every release to
 * find out costs more than the collision it would avoid - the block a game
 * allocates from is a hundred ports wide and the derived ports are spread over
 * twenty thousand.
 */

import { prisma } from "@polaris/db";
import { hostPortForApp } from "@/lib/deploy-service";
import { getPortBlocks } from "@/lib/apps/port-block-store";
import { describeBlock, inBlock, type PortProtocol } from "@/lib/apps/port-block";

/** A port on one transport. TCP 25565 and UDP 25565 are different doors, and
 *  treating them as one was costing a usable port every time. */
export type PortKey = `${PortProtocol}:${number}`;

export function portKey(port: number, protocol: PortProtocol): PortKey {
    return `${protocol}:${port}`;
}

/** What an app's stored config says about the ports it publishes. */
interface StoredPorts {
    readonly hostPort?: unknown;
    readonly hostProtocol?: unknown;
    readonly extraPorts?: unknown;
}

function asProtocol(value: unknown): PortProtocol {
    return value === "udp" ? "udp" : "tcp";
}

/** Every port in use, keyed by transport. */
export async function takenHostPorts(): Promise<Set<PortKey>> {
    const rows = await prisma.application.findMany({ select: { id: true, sourceConfig: true } });
    const taken = new Set<PortKey>();
    for (const row of rows) {
        let config: StoredPorts;
        try {
            config = JSON.parse(row.sourceConfig) as StoredPorts;
        } catch {
            // A config that will not parse pins nothing we can avoid, and the app it
            // belongs to cannot deploy either.
            continue;
        }
        if (typeof config.hostPort === "number") {
            taken.add(portKey(config.hostPort, asProtocol(config.hostProtocol)));
        } else {
            taken.add(portKey(hostPortForApp(row.id), "tcp"));
        }
        if (Array.isArray(config.extraPorts)) {
            for (const entry of config.extraPorts) {
                const extra = entry as { host?: unknown; protocol?: unknown };
                if (typeof extra.host === "number") taken.add(portKey(extra.host, asProtocol(extra.protocol)));
            }
        }
    }
    return taken;
}

/**
 * A free host port for an app that publishes one, inside the block its transport
 * allocates from.
 *
 * A game server answers on the port its players' clients assume, so the port the
 * app asks for is the one it gets whenever that is possible: the first Minecraft
 * server takes 25565 and the second 25566, rather than both fighting over one or
 * landing on a derived port nobody would think to type. What is new is the bound.
 * Every port handed out here falls inside a declared block, which is what lets the
 * operator forward one range on their router instead of a rule per server - see
 * `port-block.ts`. An app whose preferred port sits outside the block is placed
 * inside it, because a port outside the block is a port nothing opened.
 */
export async function availableHostPort(preferred: number, protocol: PortProtocol = "tcp"): Promise<number> {
    const [taken, blocks] = await Promise.all([takenHostPorts(), getPortBlocks()]);
    const block = blocks[protocol];
    const free = (port: number): boolean => !taken.has(portKey(port, protocol));
    if (inBlock(preferred, block) && free(preferred)) return preferred;
    // From the preferred port onward before wrapping, so a second server of the
    // same game lands next to the first rather than at the bottom of the block.
    const from = inBlock(preferred, block) ? preferred : block.start;
    for (let port = from; port <= block.end; port += 1) {
        if (free(port)) return port;
    }
    for (let port = block.start; port < from; port += 1) {
        if (free(port)) return port;
    }
    throw new Error(
        `Every port in the ${protocol.toUpperCase()} range ${describeBlock(block)} is in use. Widen it under Admin, Domains, or remove a server that is no longer running.`
    );
}
