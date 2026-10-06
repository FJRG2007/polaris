/**
 * Where a database's container can reach Polaris, for a dump that has to come
 * through Polaris.
 *
 * A copy from a database somewhere else is dumped by the destination's own
 * container: it has the engine's client tools, and the dashboard has none. A
 * database that is only reachable through SSH is reachable from the dashboard
 * alone - the tunnel (`lib/data/tunnel.ts`) is opened here - so the tunnel is
 * served on the container network the dashboard and that container share, to
 * that container's address alone, and the dump is pointed at it.
 *
 * Pure: the interfaces and the container's networks are the caller's to read.
 */

import { z } from "zod";

/** One of the dashboard's own interfaces, as `os.networkInterfaces()` lists it. */
export interface OwnInterface {
    readonly address: string;
    readonly netmask: string;
    readonly family: string | number;
    readonly internal: boolean;
}

/** One network a container is on, from its inspection. */
export interface ContainerNetwork {
    readonly ip: string;
    readonly prefix: number;
}

/** Where to serve the tunnel and who may use it. */
export interface Relay {
    /** The dashboard's address on the shared network: what the dump dials. */
    readonly bindHost: string;
    /** The container's own address there: the only caller let in. */
    readonly containerIp: string;
}

const inspection = z.object({
    NetworkSettings: z
        .object({
            Networks: z
                .record(
                    z.string(),
                    z
                        .object({
                            IPAddress: z.string().optional(),
                            IPPrefixLen: z.number().int().min(0).max(32).optional()
                        })
                        .passthrough()
                )
                .optional()
        })
        .passthrough()
        .optional()
});

/** The IPv4 networks a container inspection says it is on. */
export function containerNetworks(inspected: unknown): ContainerNetwork[] {
    const parsed = inspection.safeParse(inspected);
    if (!parsed.success) return [];
    return Object.values(parsed.data.NetworkSettings?.Networks ?? {}).flatMap((network) =>
        network.IPAddress && toNumber(network.IPAddress) !== null && network.IPPrefixLen
            ? [{ ip: network.IPAddress, prefix: network.IPPrefixLen }]
            : []
    );
}

function toNumber(address: string): number | null {
    const parts = address.split(".");
    if (parts.length !== 4) return null;
    let value = 0;
    for (const part of parts) {
        if (!/^\d{1,3}$/.test(part)) return null;
        const octet = Number(part);
        if (octet > 255) return null;
        value = value * 256 + octet;
    }
    return value;
}

function maskOf(prefix: number): number {
    return prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
}

function prefixOf(netmask: string): number | null {
    const mask = toNumber(netmask);
    if (mask === null) return null;
    const bits = mask.toString(2).padStart(32, "0");
    return /^1*0*$/.test(bits) ? bits.indexOf("0") === -1 ? 32 : bits.indexOf("0") : null;
}

/**
 * The dashboard's address on a network the container is also on, and the
 * container's address there; null when they share none - a database on
 * another machine, or on a network the dashboard was never joined to.
 */
export function sharedNetwork(
    own: readonly OwnInterface[],
    container: readonly ContainerNetwork[]
): Relay | null {
    for (const network of container) {
        const theirs = toNumber(network.ip);
        if (theirs === null) continue;
        const mask = maskOf(network.prefix);
        for (const face of own) {
            if (face.internal || !(face.family === "IPv4" || face.family === 4)) continue;
            const mine = toNumber(face.address);
            const prefix = prefixOf(face.netmask);
            if (mine === null || prefix !== network.prefix || mine === theirs) continue;
            if (((mine & mask) >>> 0) === ((theirs & mask) >>> 0))
                return { bindHost: face.address, containerIp: network.ip };
        }
    }
    return null;
}
