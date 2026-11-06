/**
 * The name browsers reach a VPN server's proxy by. Apart from browser-proxy.ts,
 * which the client screens reach through wireguard.ts and so must not pull in Node
 * built-ins. Server-only.
 */

import { isIP } from "node:net";
import { isPublicEndpoint } from "./wireguard";
import { DEFAULT_SUBDOMAIN_BASE, isMagicBase, magicDomain } from "@polaris/deploy";

/**
 * The name a browser reaches a node by. Its own endpoint when that is a name nothing
 * else answers on; otherwise a free wildcard-DNS name built from its public address,
 * so a server added by bare address, or by the dashboard's own name, still gets a
 * name a certificate can be issued for. Null when there is no public address. Pure.
 */
export function proxyNameFor(input: {
    readonly endpoint: string;
    /** The endpoint itself when it is an address, else what it resolved to. */
    readonly address: string | null;
    /** Whether the endpoint is a name something else already routes. */
    readonly taken: boolean;
    readonly base: string;
}): string | null {
    const endpoint = input.endpoint.trim().toLowerCase();
    if (!isIP(endpoint) && !input.taken) return endpoint;
    const address = input.address;
    // IPv4 only: the wildcard name spells the address with dashes, which an IPv6
    // one has no dotted form for.
    if (!address || isIP(address) !== 4 || !isPublicEndpoint(address)) return null;
    return magicDomain(
        "vpn",
        address,
        isMagicBase(input.base) ? input.base : DEFAULT_SUBDOMAIN_BASE
    );
}
