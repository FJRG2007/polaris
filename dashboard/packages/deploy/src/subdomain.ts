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

/** The dashed IPv4 a magic domain ends its first label with, e.g. `-51-15-20-30`. */
const TRAILING_IP = /-(\d{1,3}-\d{1,3}-\d{1,3}-\d{1,3})$/;

/** Longest release marker kept in a hostname: enough for a short commit SHA. */
const MARKER_LENGTH = 12;

/**
 * The hostname one particular release answers on, built from the service's own
 * hostname by adding a marker (normally the commit) to it:
 * `invoices-a1b2c3-51-15-20-30.sslip.io` becomes
 * `invoices-a1b2c3-9f8e7d6-51-15-20-30.sslip.io`.
 *
 * The service's own hostname is never touched - it is the address people saved,
 * and it follows whichever release is current. This is how Vercel and Railway
 * present it: one address for the service, one more per build, so an older
 * version stays reachable without ever taking over the address.
 *
 * Two shapes are protected. The marker goes INSIDE the first label, because an
 * extra dot would fall outside a single-level wildcard (`*.plr.example.com`), so
 * the name would resolve nowhere and need its own certificate. And it goes BEFORE
 * the encoded address, because wildcard DNS reads that address at the end of the
 * label - moving it would point the release at nothing.
 *
 * Null when there is nothing usable to build: no marker, no label to extend, or a
 * result past the 63-character limit a DNS label has.
 */
export function releaseDomain(hostname: string, release: string): string | null {
    const marker = slugify(release).slice(0, MARKER_LENGTH);
    const dot = hostname.indexOf(".");
    if (!marker || dot < 1) return null;
    const label = hostname.slice(0, dot);
    const address = label.match(TRAILING_IP);
    const built = address
        ? `${label.slice(0, -address[0].length)}-${marker}-${address[1]}`
        : `${label}-${marker}`;
    return built.length > 63 ? null : `${built}${hostname.slice(dot)}`;
}
