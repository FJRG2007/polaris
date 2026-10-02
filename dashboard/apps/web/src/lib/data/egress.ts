/**
 * Where a connection typed into the Databases form may point.
 *
 * Saving a connection makes Polaris dial an address somebody typed, from inside
 * its own network. Left open, that is a way to reach what only Polaris can see:
 * its own database and services by their container names, whatever listens on
 * its loopback, the house network behind it, and the cloud metadata service that
 * hands out the machine's credentials. So the address is resolved here, every
 * address it resolves to is judged, and the driver is then pointed at the
 * address that was judged - never at the name again, which a second lookup could
 * answer differently.
 *
 * The rule, by who is asking:
 *
 * - Nobody reaches the link-local range (the metadata services live there), an
 *   unspecified, multicast or broadcast address, or the few metadata addresses
 *   that sit outside it.
 * - Whoever runs the instance (`system.manage`) may reach loopback and private
 *   networks: a database on the LAN is the ordinary case for them.
 * - Everybody else reaches public addresses only. A database on a private
 *   network is still theirs to reach - through SSH on a server of their own,
 *   where it is that server's network being used, not Polaris'.
 *
 * Server-only.
 */

import { BlockList, isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";

/** Who is asking, which decides how far in the address may point. */
export type EgressScope = "instance" | "member";

/** An address that was resolved and judged, to dial instead of the name. */
export interface ResolvedEgress {
    /** The address to connect to. */
    readonly address: string;
    /** The name as typed, for TLS to check the certificate against. */
    readonly name: string;
}

export class EgressRefusal extends Error {
    constructor(message: string) {
        super(message);
        this.name = "EgressRefusal";
    }
}

/** How a name is turned into addresses. Swapped in tests. */
export type Lookup = (host: string) => Promise<readonly { address: string; family: number }[]>;

const realLookup: Lookup = (host) => dnsLookup(host, { all: true, verbatim: true });

/** Never dialled, by anybody. */
const FORBIDDEN = new BlockList();
FORBIDDEN.addSubnet("0.0.0.0", 8, "ipv4");
FORBIDDEN.addSubnet("169.254.0.0", 16, "ipv4");
FORBIDDEN.addSubnet("224.0.0.0", 4, "ipv4");
FORBIDDEN.addSubnet("240.0.0.0", 4, "ipv4");
// Alibaba Cloud's metadata service, which is not link-local.
FORBIDDEN.addAddress("100.100.100.200", "ipv4");
FORBIDDEN.addAddress("::", "ipv6");
FORBIDDEN.addSubnet("fe80::", 10, "ipv6");
FORBIDDEN.addSubnet("ff00::", 8, "ipv6");
// AWS's metadata service over IPv6.
FORBIDDEN.addAddress("fd00:ec2::254", "ipv6");

/** Dialled only by whoever runs the instance. */
const INTERNAL = new BlockList();
INTERNAL.addSubnet("127.0.0.0", 8, "ipv4");
INTERNAL.addSubnet("10.0.0.0", 8, "ipv4");
INTERNAL.addSubnet("172.16.0.0", 12, "ipv4");
INTERNAL.addSubnet("192.168.0.0", 16, "ipv4");
INTERNAL.addSubnet("100.64.0.0", 10, "ipv4");
INTERNAL.addSubnet("198.18.0.0", 15, "ipv4");
INTERNAL.addAddress("::1", "ipv6");
INTERNAL.addSubnet("fc00::", 7, "ipv6");

export type AddressClass = "forbidden" | "internal" | "public";

/**
 * What kind of address this is. An IPv4 address carried inside IPv6 (mapped,
 * or behind the NAT64 prefix) is judged as the IPv4 address it is, since that
 * is where the packet ends up.
 */
export function classifyAddress(address: string): AddressClass {
    const family = isIP(address);
    if (family === 0) return "forbidden";
    if (family === 6) {
        const embedded = embeddedIpv4(address);
        if (embedded) return classifyAddress(embedded);
        if (FORBIDDEN.check(address, "ipv6")) return "forbidden";
        return INTERNAL.check(address, "ipv6") ? "internal" : "public";
    }
    if (FORBIDDEN.check(address, "ipv4")) return "forbidden";
    if (address === "255.255.255.255") return "forbidden";
    return INTERNAL.check(address, "ipv4") ? "internal" : "public";
}

function embeddedIpv4(address: string): string | null {
    const lower = address.toLowerCase();
    const dotted = /^(?:::ffff:|64:ff9b::)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower);
    if (dotted) return dotted[1] as string;
    const hex = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
    if (!hex) return null;
    const high = Number.parseInt(hex[1] as string, 16);
    const low = Number.parseInt(hex[2] as string, 16);
    return [high >> 8, high & 255, low >> 8, low & 255].join(".");
}

/** The sentences a refusal is said in. Matched back to the catalog by
 *  `lib/data/words`. */
export const EGRESS_REFUSALS = {
    forbidden: (host: string) =>
        `Polaris does not connect to ${host}: it is a link-local or metadata address, which never holds a database.`,
    internal: (host: string) =>
        `${host} is on a private network, which only an administrator can reach from Polaris. Reach it over SSH through a server of yours instead.`,
    unresolved: (host: string) => `Polaris could not find ${host}. Check the name.`
} as const;

/**
 * The address to dial for `host`, judged for `scope`, or a refusal that says
 * why. Every address the name resolves to has to pass: a name that answers
 * with one public address and one private one is refused, since which of them
 * a driver would pick is not something to leave to chance.
 */
export async function resolveEgress(
    host: string,
    scope: EgressScope,
    lookup: Lookup = realLookup
): Promise<ResolvedEgress> {
    const name = host.trim().replace(/^\[(.*)\]$/, "$1");
    let addresses: readonly string[];
    if (isIP(name)) {
        addresses = [name];
    } else {
        try {
            addresses = (await lookup(name)).map((entry) => entry.address);
        } catch {
            addresses = [];
        }
        if (addresses.length === 0) throw new EgressRefusal(EGRESS_REFUSALS.unresolved(name));
    }

    for (const address of addresses) {
        const kind = classifyAddress(address);
        if (kind === "forbidden") throw new EgressRefusal(EGRESS_REFUSALS.forbidden(name));
        if (kind === "internal" && scope !== "instance") {
            throw new EgressRefusal(EGRESS_REFUSALS.internal(name));
        }
    }
    return { address: addresses[0] as string, name };
}
