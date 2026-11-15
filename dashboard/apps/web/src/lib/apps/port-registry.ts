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
import { getPortRangesFor } from "@/lib/apps/port-block-store";
import { portKey, type PortKey } from "./port-key";
import { describeRanges, type PortBlock, type PortProtocol } from "@/lib/apps/port-block";

export { portKey, type PortKey } from "./port-key";

/** What an app's stored config says about the ports it publishes. */
interface StoredPorts {
    readonly hostPort?: unknown;
    readonly hostProtocol?: unknown;
    readonly extraPorts?: unknown;
    readonly tcpProxies?: unknown;
}

function asProtocol(value: unknown): PortProtocol {
    return value === "udp" ? "udp" : "tcp";
}

/** How many applications one read of the port walk holds at a time. */
const TAKEN_PAGE = 1000;

/**
 * Every port in use, keyed by transport - on one host when `targetId` is given,
 * since two hosts can publish the same port without meeting.
 *
 * Read in pages by id rather than in one go: on a hosting deployment the
 * application table is far larger than the 131 070 ports this set can ever hold.
 */
export async function takenHostPorts(targetId?: string | null): Promise<Set<PortKey>> {
    const taken = new Set<PortKey>();
    let cursor: string | null = null;
    for (;;) {
        const rows: { id: string; sourceConfig: string }[] = await prisma.application.findMany({
            where: targetId ? { targetId } : {},
            select: { id: true, sourceConfig: true },
            orderBy: { id: "asc" },
            take: TAKEN_PAGE,
            ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {})
        });
        for (const row of rows) noteTaken(taken, row);
        if (rows.length < TAKEN_PAGE) return taken;
        cursor = rows[rows.length - 1]!.id;
    }
}

function noteTaken(taken: Set<PortKey>, row: { id: string; sourceConfig: string }): void {
    let config: StoredPorts;
    try {
        config = JSON.parse(row.sourceConfig) as StoredPorts;
    } catch {
        return;
    }
    if (typeof config.hostPort === "number") {
        taken.add(portKey(config.hostPort, asProtocol(config.hostProtocol)));
    } else {
        taken.add(portKey(hostPortForApp(row.id), "tcp"));
    }
    for (const list of [config.extraPorts, config.tcpProxies]) {
        if (!Array.isArray(list)) continue;
        for (const entry of list) {
            const extra = entry as { host?: unknown; protocol?: unknown };
            if (typeof extra.host === "number") taken.add(portKey(extra.host, asProtocol(extra.protocol)));
        }
    }
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
export async function availableHostPort(
    preferred: number,
    protocol: PortProtocol = "tcp",
    targetId?: string | null
): Promise<number> {
    return availableHostPortRun(preferred, 1, protocol, targetId);
}

/**
 * The first of a run of free host ports, all inside the block its transport
 * allocates from.
 *
 * A run rather than a port because some servers publish several doors that are
 * arithmetically tied to each other: ARK's raw socket has to be exactly one above
 * its game port, and that is true of the ports players reach, not only the ones
 * inside the container. Allocating those one call at a time cannot work - the
 * first is not recorded anywhere until the application exists, so the second call
 * would hand out the same port again.
 *
 * The rules are otherwise `availableHostPort`'s: the preferred port is honoured
 * whenever the run fits there, so the first server of a game lands where its
 * players' clients assume, and the search walks forward from it before wrapping so
 * the second lands beside the first.
 */
export async function availableHostPortRun(
    preferred: number,
    count: number,
    protocol: PortProtocol = "tcp",
    targetId?: string | null
): Promise<number> {
    if (!Number.isInteger(count) || count < 1)
        throw new Error("A run of ports is at least one port long");
    const [taken, ranges] = await Promise.all([takenHostPorts(targetId), getPortRangesFor(targetId)]);
    const found = firstFreeRun(preferred, count, ranges[protocol], (port) => taken.has(portKey(port, protocol)));
    if (found !== null) return found;
    const described = describeRanges(ranges[protocol]);
    throw new Error(
        count === 1
            ? `Every port in the ${protocol.toUpperCase()} ranges ${described} is in use. Widen them under Admin, Domains, or remove a server that is no longer running.`
            : `No run of ${count} free ports is left in the ${protocol.toUpperCase()} ranges ${described}. Widen them under Admin, Domains, or remove a server that is no longer running.`
    );
}

/**
 * The first start of `count` free ports that fits wholly inside one range. The
 * preferred port wins when it fits; otherwise the range holding it is walked from
 * there and wrapped, then every other range in order. Pure, for the tests.
 */
export function firstFreeRun(
    preferred: number,
    count: number,
    ranges: readonly PortBlock[],
    isTaken: (port: number) => boolean
): number | null {
    const fitsIn = (start: number, range: PortBlock): boolean => {
        if (start < range.start || start + count - 1 > range.end) return false;
        for (let port = start; port < start + count; port += 1) if (isTaken(port)) return false;
        return true;
    };
    const home = ranges.find((range) => preferred >= range.start && preferred <= range.end);
    if (home && fitsIn(preferred, home)) return preferred;
    const ordered = home ? [home, ...ranges.filter((range) => range !== home)] : ranges;
    for (const range of ordered) {
        const from = range === home ? preferred : range.start;
        for (let start = from; start <= range.end; start += 1) if (fitsIn(start, range)) return start;
        for (let start = range.start; start < from; start += 1) if (fitsIn(start, range)) return start;
    }
    return null;
}
