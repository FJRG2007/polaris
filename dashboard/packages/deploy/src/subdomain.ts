/**
 * Free auto-subdomains via wildcard-DNS "magic" domains (sslip.io / traefik.me).
 * `<name>-<hash>-<ip-dashed>.sslip.io` resolves to the encoded IP with zero DNS
 * setup, so a deployed app, a preview, or a Drive share/drop link gets an instant
 * HTTPS hostname (Traefik issues the Let's Encrypt cert for it). Pure.
 */

import { shortHash, slugify } from "./naming.js";

/** Default wildcard-DNS base. sslip.io and traefik.me behave identically. */
export const DEFAULT_SUBDOMAIN_BASE = "sslip.io";

/** IPv4 in dashed form (sslip.io accepts `1-2-3-4` as well as `1.2.3.4`). */
function dashIp(ip: string): string {
    return ip.trim().replace(/\./g, "-");
}

/**
 * Build a free subdomain for `name` pointing at `ip`. A short hash of the name
 * keeps two apps with the same slug on distinct hostnames. When `ip` is empty the
 * base is a real wildcard domain the operator already points at the host, so the
 * IP segment is omitted.
 */
export function magicDomain(name: string, ip: string, base: string = DEFAULT_SUBDOMAIN_BASE): string {
    const slug = slugify(name) || "app";
    const hash = shortHash(name, 6);
    const host = ip ? `${slug}-${hash}-${dashIp(ip)}` : `${slug}-${hash}`;
    return `${host}.${base}`;
}

/** Whether a base looks like a wildcard-DNS magic domain (needs the IP segment). */
export function isMagicBase(base: string): boolean {
    return base === "sslip.io" || base === "traefik.me" || base === "nip.io";
}
