/**
 * A name for this machine's LAN address under the operator's own domain, on a public
 * certificate - the way Plex gives every server `<ip-dashed>.<hash>.plex.direct`
 * (https://words.filippo.io/how-plex-is-doing-https-for-all-its-users/).
 *
 * `https://192.168.1.142` and `https://polaris.local` are served with the local CA's
 * certificate, so a page on the public domain can never fetch them: once a reader has
 * clicked through that certificate, Chrome lets the fetch run and marks the asking page
 * "Not secure". `lan-192-168-1-142.<base>` resolves in public DNS to the same private
 * address and is covered by the `*.<base>` wildcard Polaris already orders over DNS-01
 * (`wildcard-cert-service.ts`), so the connection banner can prove it and switch to it
 * with no warning anywhere.
 *
 * It needs what the wildcard needs - a deploy domain and a Cloudflare token that writes
 * its zone - plus the LAN address the responder reports. Without any of them there is
 * no name, the route file is empty, and the banner offers the local address as before
 * without asking it. A router whose DNS rebinding protection refuses public names that
 * resolve to private addresses (Plex documents the same:
 * https://support.plex.tv/articles/206225077-how-to-use-secure-server-connections/)
 * simply never answers on the name, and the banner falls back the same way.
 */

import { NO_ROUTES_FILE } from "@polaris/core";
import { getHostLanIp } from "@/lib/host-address";
import { writeDynamicFile } from "@/lib/traefik-dynamic";
import { getSetting, setSetting } from "@/lib/setting-store";
import { trustedWildcardBase } from "@/lib/wildcard-cert-service";
import { loadCloudflareToken } from "@/lib/integrations/cloudflare-account-service";
import {
    deleteDnsRecordIfPresent,
    findDnsRecords,
    resolveZoneForHostname,
    upsertARecord
} from "@/lib/integrations/cloudflare-api";

const FILE = "polaris-lan-name.yml";
const ROUTER = "polaris-lan-name";
/** Same rank as the dashboard's public hostnames: below the host-less path routers at
 *  100, which must keep winning their prefix on this name, above the compose catch-all. */
const PRIORITY = 50;
/** The name last published, so a changed LAN address takes its old record with it. */
export const LAN_NAME_SETTING = "lan.trustedHost";
/** Private ranges only: the name resolves to a LAN address, so nothing else has a
 *  reason to send it. Someone naming it on the public address is refused here rather
 *  than slipping past the firewall rule the public hostnames carry. */
const LAN_RANGES = [
    "127.0.0.0/8",
    "10.0.0.0/8",
    "172.16.0.0/12",
    "192.168.0.0/16",
    "169.254.0.0/16",
    "100.64.0.0/10",
    "::1/128",
    "fc00::/7",
    "fe80::/10"
];

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** `lan-192-168-1-142.<base>`, or null for anything that is not a private IPv4. One
 *  label under the base, so the `*.<base>` wildcard covers it. */
export function lanHostname(ip: string, base: string): string | null {
    const match = IPV4.exec(ip);
    if (!match || match.slice(1).some((part) => Number(part) > 255)) return null;
    const [a, b] = [Number(match[1]), Number(match[2])];
    const lan = a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
    if (!lan || !base) return null;
    return `lan-${ip.replace(/\./g, "-")}.${base.toLowerCase()}`;
}

/** The edge route for the name: TLS from the certificate store (the wildcard), never
 *  an ACME order, which an HTTP-01 challenge on a private address could not pass. */
export function renderLanRoute(host: string | null, origin: string): string {
    if (!host) return NO_ROUTES_FILE;
    return [
        "http:",
        "  routers:",
        `    ${ROUTER}:`,
        `      rule: "Host(\`${host}\`)"`,
        "      entryPoints: [websecure]",
        `      priority: ${PRIORITY}`,
        `      service: ${ROUTER}`,
        `      middlewares: [${ROUTER}-lan]`,
        "      tls: {}",
        "  services:",
        `    ${ROUTER}:`,
        "      loadBalancer:",
        "        servers:",
        `          - url: "${origin}"`,
        "  middlewares:",
        `    ${ROUTER}-lan:`,
        "      ipAllowList:",
        `        sourceRange: [${LAN_RANGES.map((range) => `"${range}"`).join(", ")}]`,
        ""
    ].join("\n");
}

/** The name in use, for the instance record: only once its record and route exist. */
export async function currentLanHostname(): Promise<string | null> {
    return getSetting(LAN_NAME_SETTING).catch(() => null);
}

/**
 * Publish the name: its A record, then its route. Idempotent and best-effort - a
 * failure leaves the banner on its fallback, which is how every install without a
 * Cloudflare token already works. Called with the dashboard route, so on startup,
 * on every domain change and after each wildcard pass.
 */
export async function syncLanHostname(origin: string): Promise<void> {
    const [base, ip, token, previous] = await Promise.all([
        trustedWildcardBase().catch(() => null),
        getHostLanIp().catch(() => null),
        loadCloudflareToken().catch(() => null),
        currentLanHostname()
    ]);
    const host = base && ip && token ? lanHostname(ip, base) : null;
    try {
        if (host && token && ip) {
            const zone = await resolveZoneForHostname(token, host);
            await upsertARecord(token, zone.id, host, ip);
            if (previous && previous !== host) await dropRecord(token, previous);
        }
        await setSetting(LAN_NAME_SETTING, host);
        await writeDynamicFile(FILE, renderLanRoute(host, origin));
    } catch (error) {
        console.error(
            "polaris: publishing the LAN name failed:",
            error instanceof Error ? error.message : error
        );
    }
}

async function dropRecord(token: string, host: string): Promise<void> {
    const zone = await resolveZoneForHostname(token, host);
    for (const record of await findDnsRecords(token, zone.id, "A", host)) {
        await deleteDnsRecordIfPresent(token, zone.id, record.id);
    }
}
