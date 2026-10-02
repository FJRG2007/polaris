/**
 * The decisions behind a service's public networking panel, with nothing to dial.
 *
 * Pure so each one is pinned by a test: which ports a container listens on, read
 * from the kernel's own socket table; what a custom hostname's DNS says about where
 * it points and whether Cloudflare is in front of it; and how far a certificate is
 * from expiring. The server module (`public-networking.ts`) gathers the inputs.
 */

import { ipInCidr } from "@polaris/core";

/**
 * Cloudflare's published edge ranges, as https://www.cloudflare.com/ips-v4 and
 * https://www.cloudflare.com/ips-v6 list them (read 2026-10-02). A hostname that
 * resolves into one of these is proxied ("orange cloud"): the address it shows is
 * Cloudflare's, never this server's, so "does it point here" has to be answered
 * differently for it.
 */
export const CLOUDFLARE_RANGES: readonly string[] = [
    "173.245.48.0/20",
    "103.21.244.0/22",
    "103.22.200.0/22",
    "103.31.4.0/22",
    "141.101.64.0/18",
    "108.162.192.0/18",
    "190.93.240.0/20",
    "188.114.96.0/20",
    "197.234.240.0/22",
    "198.41.128.0/17",
    "162.158.0.0/15",
    "104.16.0.0/13",
    "104.24.0.0/14",
    "172.64.0.0/13",
    "131.0.72.0/22",
    "2400:cb00::/32",
    "2606:4700::/32",
    "2803:f800::/32",
    "2405:b500::/32",
    "2405:8100::/32",
    "2a06:98c0::/29",
    "2c0f:f248::/32"
];

export function isCloudflareAddress(address: string): boolean {
    return CLOUDFLARE_RANGES.some((range) => ipInCidr(address, range));
}

/** The TCP state the kernel writes for a listening socket in `/proc/net/tcp`. */
const TCP_LISTEN = "0A";

/**
 * The TCP ports a container listens on, from the text of `/proc/net/tcp` and
 * `/proc/net/tcp6` read inside it.
 *
 * Only sockets another container can reach count: one bound to loopback answers
 * the process itself and nobody else, and offering it as a target port would be
 * offering a 502. Sorted and unique, because tcp and tcp6 usually list the same
 * port twice.
 */
export function parseListeningPorts(table: string): number[] {
    const ports = new Set<number>();
    for (const line of table.split("\n")) {
        const fields = line.trim().split(/\s+/);
        // sl local_address rem_address st ...
        if (fields.length < 4 || fields[3] !== TCP_LISTEN) continue;
        const local = fields[1] ?? "";
        const colon = local.lastIndexOf(":");
        if (colon <= 0) continue;
        const address = local.slice(0, colon);
        const port = parseInt(local.slice(colon + 1), 16);
        if (!Number.isInteger(port) || port < 1 || port > 65_535) continue;
        if (isLoopbackHex(address)) continue;
        ports.add(port);
    }
    return [...ports].sort((a, b) => a - b);
}

/** Whether a hex address from the socket table is a loopback one: 127.0.0.0/8 as
 *  the kernel writes it (little-endian, so the first octet is the last byte), or
 *  `::1`, or `::ffff:127.x.x.x`. */
function isLoopbackHex(address: string): boolean {
    const hex = address.toUpperCase();
    if (hex.length === 8) return hex.endsWith("7F");
    if (hex.length === 32) {
        if (hex === "00000000000000000000000001000000") return true;
        // An IPv4-mapped address: ::ffff:a.b.c.d is 0000...FFFF0000 + the v4 word.
        if (hex.startsWith("0000000000000000FFFF0000")) return hex.endsWith("7F");
    }
    return false;
}

/** What a custom hostname's DNS was found to say. */
export type DnsVerdict =
    /** It resolves to this server, or is a CNAME to one of the service's own names. */
    | "ok"
    /** It resolves to Cloudflare's edge: proxied, so where it ends up is not visible. */
    | "proxied"
    /** It resolves somewhere else. */
    | "elsewhere"
    /** It does not resolve yet. */
    | "missing";

export interface DnsReading {
    readonly addresses: readonly string[];
    readonly cnames: readonly string[];
}

export function dnsVerdict(
    reading: DnsReading,
    expected: { readonly ip: string | null; readonly cnameTargets: readonly string[] }
): DnsVerdict {
    const targets = new Set(
        expected.cnameTargets.map((name) => name.toLowerCase().replace(/\.$/, ""))
    );
    if (reading.cnames.some((name) => targets.has(name.toLowerCase().replace(/\.$/, ""))))
        return "ok";
    if (reading.addresses.length === 0) return "missing";
    if (expected.ip && reading.addresses.includes(expected.ip)) return "ok";
    if (reading.addresses.some(isCloudflareAddress)) return "proxied";
    return "elsewhere";
}

/** What a certificate's dates mean today. */
export type CertVerdict = "valid" | "renewing" | "expired" | "untrusted";

/** Let's Encrypt certificates are renewed with 30 days left, as Traefik and the
 *  DNS-01 planner both do; inside that window a certificate is due, not wrong. */
export const RENEW_WITHIN_DAYS = 30;

export function certVerdict(
    cert: { readonly validTo: Date; readonly trusted: boolean },
    now: number
): CertVerdict {
    if (!cert.trusted) return "untrusted";
    const left = cert.validTo.getTime() - now;
    if (left <= 0) return "expired";
    return left < RENEW_WITHIN_DAYS * 86_400_000 ? "renewing" : "valid";
}

/** Whole days until a date, never negative. */
export function daysUntil(date: Date, now: number): number {
    return Math.max(0, Math.floor((date.getTime() - now) / 86_400_000));
}

/** The range public TCP proxy ports are drawn from: above the 20000-39999 band
 *  services' own published ports come from (`hostPortForApp`), so the two never
 *  collide, and below the ephemeral range most kernels start at 49152. */
export const TCP_PROXY_PORT_MIN = 40_000;
export const TCP_PROXY_PORT_MAX = 49_151;

/**
 * A free public port for a TCP proxy, or null when the range is full.
 *
 * Starts from a point derived from the seed so two services asking at once do
 * not race for the same number, then walks the range for the first one nobody
 * on that machine holds.
 */
export function pickProxyPort(taken: ReadonlySet<number>, seed: number): number | null {
    const span = TCP_PROXY_PORT_MAX - TCP_PROXY_PORT_MIN + 1;
    const start = ((seed % span) + span) % span;
    for (let step = 0; step < span; step += 1) {
        const port = TCP_PROXY_PORT_MIN + ((start + step) % span);
        if (!taken.has(port)) return port;
    }
    return null;
}

/** One TCP proxy as stored on a service's source config. */
export interface TcpProxy {
    /** The port inside the container. */
    readonly container: number;
    /** The public port the machine publishes it on. */
    readonly host: number;
}

/** The TCP proxies stored on a source config, ignoring anything malformed. */
export function tcpProxiesOf(source: Record<string, unknown>): TcpProxy[] {
    if (!Array.isArray(source.tcpProxies)) return [];
    return source.tcpProxies.flatMap((entry: unknown) => {
        if (typeof entry !== "object" || entry === null) return [];
        const value = entry as { container?: unknown; host?: unknown };
        return typeof value.container === "number" && typeof value.host === "number"
            ? [{ container: value.container, host: value.host }]
            : [];
    });
}

/** Every host port a stored source config already publishes, so a new proxy
 *  never takes one of them. */
export function publishedPortsOf(source: Record<string, unknown>): number[] {
    const ports: number[] = [];
    if (typeof source.hostPort === "number") ports.push(source.hostPort);
    for (const list of [source.extraPorts, source.tcpProxies]) {
        if (!Array.isArray(list)) continue;
        for (const entry of list) {
            const host = (entry as { host?: unknown } | null)?.host;
            if (typeof host === "number") ports.push(host);
        }
    }
    return ports;
}

/**
 * Whether the edge dials a domain on a port of its own. It does where the
 * container is reached by name: on this machine's edge for the release the
 * service serves, and on a server whose own edge serves the domain. A domain
 * fronted here for another server, tied to one release, or served by a kept
 * release is reached on the port the machine publishes, which is always the
 * service's own.
 */
export function dialsPinnedPort(
    domain: { readonly deploymentId: string | null; readonly servedBy: string },
    service: { readonly remote: boolean; readonly keptRelease: boolean }
): boolean {
    if (service.remote) return domain.servedBy !== "polaris";
    return domain.deploymentId === null && !service.keptRelease;
}
