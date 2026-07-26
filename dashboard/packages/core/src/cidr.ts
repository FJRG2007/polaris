/**
 * IP parsing, classification, and allowlist matching. Allowlists are a security
 * boundary, so parsing is delegated to ipaddr.js (a vetted, widely deployed
 * library) rather than hand-rolled bit math that could subtly admit an address it
 * should reject - especially for IPv6 and IPv4-mapped-IPv6 forms.
 */

import ipaddr from "ipaddr.js";

/** True if the string parses as a single IPv4/IPv6 address (not a range). */
export function isIpAddress(value: string): boolean {
    return ipaddr.isValid(value);
}

/** True if the string parses as a CIDR range such as "10.0.0.0/8" or "fe80::/10". */
export function isCidr(value: string): boolean {
    try {
        ipaddr.parseCIDR(value);
        return true;
    } catch {
        return false;
    }
}

/**
 * Parse an address, folding an IPv4-mapped IPv6 form (::ffff:1.2.3.4) to its IPv4
 * address first: ipaddr.js classifies the mapped form as its own `ipv4Mapped`
 * range, which would hide the real address from every range check below.
 */
function parseFolded(value: string): ipaddr.IPv4 | ipaddr.IPv6 {
    const addr = ipaddr.parse(value.trim());
    if (addr.kind() === "ipv6" && (addr as ipaddr.IPv6).isIPv4MappedAddress()) {
        return (addr as ipaddr.IPv6).toIPv4Address();
    }
    return addr;
}

/**
 * True when an address is not publicly routable: RFC1918 private space, carrier
 * NAT, link-local, loopback, multicast, or reserved. Anything that is not a valid
 * address (a hostname, an empty string) counts as private, so a caller never
 * treats an unresolved value as internet-reachable.
 */
export function isPrivateIp(value: string): boolean {
    try {
        return parseFolded(value).range() !== "unicast";
    } catch {
        return true;
    }
}

/**
 * True when the value is an IPv4 literal (an IPv4-mapped IPv6 counts). Callers
 * that encode an address into a DNS label - the magic subdomains, which replace
 * dots - need this: an IPv6 address cannot survive into a hostname, so it can
 * never back a subdomain however routable it is.
 */
export function isIpv4(value: string): boolean {
    try {
        return parseFolded(value).kind() === "ipv4";
    } catch {
        return false;
    }
}

/** True when an address is an internet-routable IPv4, the combination a caller
 *  needs before treating it as a publicly reachable subdomain address. */
export function isPublicIpv4(value: string): boolean {
    return isIpv4(value) && !isPrivateIp(value);
}

/**
 * True when an address sits in carrier-grade NAT space (100.64.0.0/10): the ISP
 * shares one public address across customers, so no port forward can ever expose
 * a server on that line - only an outbound tunnel can.
 */
export function isCarrierGradeNat(value: string): boolean {
    try {
        return parseFolded(value).range() === "carrierGradeNat";
    } catch {
        return false;
    }
}

/**
 * Test whether an address falls inside a single CIDR. IPv4-mapped IPv6 addresses
 * (::ffff:1.2.3.4) are folded to their IPv4 form first so a "1.2.3.0/24" rule
 * matches a client that arrived over a dual-stack socket. Any parse failure is
 * treated as no-match: a malformed rule never widens access.
 */
export function ipInCidr(address: string, cidr: string): boolean {
    try {
        let addr = ipaddr.parse(address);
        const [range, bits] = ipaddr.parseCIDR(cidr);
        if (addr.kind() !== range.kind()) {
            if (addr.kind() === "ipv6" && (addr as ipaddr.IPv6).isIPv4MappedAddress()) {
                addr = (addr as ipaddr.IPv6).toIPv4Address();
            } else {
                return false;
            }
        }
        if (addr.kind() !== range.kind()) return false;
        return addr.match(range, bits);
    } catch {
        return false;
    }
}

/**
 * Test an address against a list of allow rules, where each rule is either a
 * bare address or a CIDR range. An empty list means "no restriction" and admits
 * everything; a non-empty list admits only addresses matching at least one rule.
 */
export function ipAllowed(address: string, rules: readonly string[]): boolean {
    if (rules.length === 0) return true;
    return rules.some((rule) => (isCidr(rule) ? ipInCidr(address, rule) : sameAddress(address, rule)));
}

function sameAddress(a: string, b: string): boolean {
    try {
        return ipaddr.parse(a).toNormalizedString() === ipaddr.parse(b).toNormalizedString();
    } catch {
        return false;
    }
}
