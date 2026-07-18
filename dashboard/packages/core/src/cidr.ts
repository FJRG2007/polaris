/**
 * IP allowlist matching for file-request access control. Allowlists are a
 * security boundary, so parsing is delegated to ipaddr.js (a vetted, widely
 * deployed library) rather than hand-rolled bit math that could subtly admit an
 * address it should reject - especially for IPv6 and IPv4-mapped-IPv6 forms.
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
