/**
 * Where the ad blocker's DNS server is published on this machine.
 *
 * Exactly port 53, on both transports: a router can only be pointed at an
 * address, never a port, and DNS falls back to TCP for long answers. Bound to the
 * LAN address only, never every interface: on most Linux machines the system's
 * own resolver already listens on a loopback address of port 53, and a bind on
 * all of them collides with it before the server ever starts.
 */

import type { InstallPorts } from "@/lib/apps/install-service";

export const DNS_PORT = 53;

/** The ports the DNS server is installed with, bound to `address`. Pure. */
export function dnsPublishSpec(address: string): InstallPorts {
    return {
        primary: { host: DNS_PORT, container: DNS_PORT, protocol: "udp" },
        extra: [{ host: DNS_PORT, container: DNS_PORT, protocol: "tcp" }],
        hostIp: address
    };
}

/**
 * An engine's stored source with its ports bound to `address`, or null when it
 * already is. An engine installed before the ports were bound published on every
 * interface, and Retry deploys again with exactly what it stored. Pure.
 */
export function boundSource(stored: string, address: string): string | null {
    let source: Record<string, unknown> = {};
    try {
        const parsed: unknown = JSON.parse(stored);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
            source = parsed as Record<string, unknown>;
    } catch {
        // An unreadable one is rewritten with the ports alone.
    }
    if (source.hostIp === address) return null;
    const ports = dnsPublishSpec(address);
    return JSON.stringify({
        ...source,
        hostPort: ports.primary?.host,
        hostProtocol: ports.primary?.protocol,
        extraPorts: ports.extra,
        hostIp: address
    });
}
