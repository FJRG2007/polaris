/**
 * Where the network filter's DNS server is published on this machine.
 *
 * Exactly port 53, on both transports: a router can only be pointed at an
 * address, never a port, and DNS falls back to TCP for long answers. Bound to the
 * LAN address only, never every interface: on most Linux machines the system's
 * own resolver already listens on a loopback address of port 53, and a bind on
 * all of them collides with it before the server ever starts.
 *
 * Encrypted DNS adds TCP 853 on the same address, only while it is on: the port is
 * the container's own, published by the deploy Polaris already runs, so it needs
 * nothing from the install it runs on.
 */

import { DOT_PORT } from "./dot";
import type { InstallPorts } from "@/lib/apps/install-service";

export const DNS_PORT = 53;

/** The ports the DNS server is installed with, bound to `address`, with 853 when
 *  it serves encrypted DNS. Pure. */
export function dnsPublishSpec(address: string, tls = false): InstallPorts {
    return {
        primary: { host: DNS_PORT, container: DNS_PORT, protocol: "udp" },
        extra: [
            { host: DNS_PORT, container: DNS_PORT, protocol: "tcp" },
            ...(tls ? [{ host: DOT_PORT, container: DOT_PORT, protocol: "tcp" as const }] : [])
        ],
        hostIp: address
    };
}

/** Whether a stored source publishes the encrypted DNS port. */
function publishesTls(source: Record<string, unknown>): boolean {
    const extra = source.extraPorts;
    return (
        Array.isArray(extra) &&
        extra.some(
            (port) =>
                port !== null &&
                typeof port === "object" &&
                (port as Record<string, unknown>).container === DOT_PORT
        )
    );
}

/**
 * An engine's stored source with its ports bound to `address` (and 853 published
 * exactly when `tls`), or null when it already is. An engine installed before the
 * ports were bound published on every interface, and Retry deploys again with
 * exactly what it stored. Pure.
 */
export function boundSource(stored: string, address: string, tls = false): string | null {
    let source: Record<string, unknown> = {};
    try {
        const parsed: unknown = JSON.parse(stored);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
            source = parsed as Record<string, unknown>;
    } catch {
        // An unreadable one is rewritten with the ports alone.
    }
    if (source.hostIp === address && publishesTls(source) === tls) return null;
    const ports = dnsPublishSpec(address, tls);
    return JSON.stringify({
        ...source,
        hostPort: ports.primary?.host,
        hostProtocol: ports.primary?.protocol,
        extraPorts: ports.extra,
        hostIp: address
    });
}

/** Whether an engine's stored source publishes the encrypted DNS port. Pure. */
export function sourcePublishesTls(stored: string): boolean {
    try {
        const parsed: unknown = JSON.parse(stored);
        return Boolean(parsed) && typeof parsed === "object" && !Array.isArray(parsed)
            ? publishesTls(parsed as Record<string, unknown>)
            : false;
    } catch {
        return false;
    }
}

/**
 * The address an engine's stored source binds its ports to, or null when it binds
 * none (an engine from before the ports were bound, which listens on every
 * interface and so has nothing to follow). Pure.
 */
export function boundAddress(stored: string): string | null {
    try {
        const parsed: unknown = JSON.parse(stored);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
        const hostIp = (parsed as Record<string, unknown>).hostIp;
        return typeof hostIp === "string" && hostIp.trim() ? hostIp.trim() : null;
    } catch {
        return null;
    }
}
