/**
 * Proof that the DNS the guided setup asked for actually exists, and - when the
 * operator has connected a Cloudflare API token - the ability to create it for them.
 *
 * The check resolves a random label inside each zone rather than the zone host
 * itself: only a real wildcard record answers for a name nobody has ever created, so
 * this catches the common half-done setup (the `plr.example.com` A record added, the
 * `*.plr.example.com` one forgotten) that would otherwise surface as every deployed
 * service getting a hostname that resolves nowhere.
 */

import { resolve4 } from "node:dns/promises";
import { randomLabel } from "@polaris/deploy";
import { getDomainZones, setZoneDnsVerified, zoneRecords } from "./domain-zones";
import { detectPublicIp } from "./network-service";
import { loadCloudflareToken } from "./integrations/cloudflare-account-service";
import { resolveZoneForHostname, upsertARecord } from "./integrations/cloudflare-api";

export interface ZoneDnsCheck {
    /** The zone's own hostname (`plr.example.com`). */
    host: string;
    /** The wildcard record the zone needs. */
    wildcard: string;
    /** What a name inside the zone resolves to today. */
    addresses: string[];
    /** True when the wildcard resolves and points at this server. */
    ok: boolean;
    detail: string;
}

export interface ZoneDnsReport {
    /** The address the records should point at, when one is known. */
    expectedIp: string | null;
    zones: ZoneDnsCheck[];
}

/** Resolve one name, returning an empty list rather than throwing on NXDOMAIN. */
async function resolveOrEmpty(hostname: string): Promise<string[]> {
    try {
        return await resolve4(hostname);
    } catch {
        return [];
    }
}

/** Check every configured zone's wildcard, against the server's public IP. */
export async function checkZoneDns(): Promise<ZoneDnsReport> {
    const [config, expectedIp] = await Promise.all([getDomainZones(), detectPublicIp()]);
    const records = zoneRecords(config);
    const zones = await Promise.all(
        records.map(async (record) => {
            const addresses = await resolveOrEmpty(`${randomLabel(3)}.${record.host}`);
            if (addresses.length === 0) {
                return {
                    host: record.host,
                    wildcard: record.wildcard,
                    addresses,
                    ok: false,
                    detail: `No DNS answer for ${record.wildcard} yet. Records can take a few minutes to propagate.`
                };
            }
            // Without a known public IP the record cannot be compared, only confirmed
            // to exist - which is still the useful half of the answer.
            const ok = !expectedIp || addresses.includes(expectedIp);
            return {
                host: record.host,
                wildcard: record.wildcard,
                addresses,
                ok,
                detail: ok
                    ? `Resolves to ${addresses.join(", ")}.`
                    : `Resolves to ${addresses.join(", ")}, but this server is at ${expectedIp}.`
            };
        })
    );
    // "Verified" has to mean "seen resolving HERE", so it is only recorded when the
    // server's own address is known to compare against: without it, a wildcard
    // pointing at a completely different machine would look like proof and promote
    // every share link onto it.
    if (expectedIp) await setZoneDnsVerified(zones.length > 0 && zones.every((zone) => zone.ok));
    return { expectedIp, zones };
}

export interface ZoneDnsProvisionResult {
    created: string[];
    failed: Array<{ name: string; detail: string }>;
}

/**
 * Create the zone and wildcard A records through the connected Cloudflare account,
 * so an operator whose domain is already on Cloudflare never opens its dashboard.
 * Idempotent: existing records are updated to the current IP. Throws when there is
 * no token, no domain, or no detectable public IP - each with what to do about it.
 */
export async function provisionZoneDns(): Promise<ZoneDnsProvisionResult> {
    const [config, token, ip] = await Promise.all([getDomainZones(), loadCloudflareToken(), detectPublicIp()]);
    if (!config.baseDomain) throw new Error("Set a base domain first");
    if (!token) throw new Error("Connect a Cloudflare API token under Integrations first");
    if (!ip) throw new Error("Polaris could not detect this server's public IP, so it does not know what to point DNS at");

    const zone = await resolveZoneForHostname(token, config.baseDomain);
    const result: ZoneDnsProvisionResult = { created: [], failed: [] };
    // Sequential on purpose: Cloudflare rate-limits per account, and a handful of
    // records is not worth risking a 429 that leaves the layout half-created.
    for (const record of zoneRecords(config)) {
        for (const name of [record.host, record.wildcard]) {
            try {
                await upsertARecord(token, zone.id, name, ip);
                result.created.push(name);
            } catch (caught) {
                result.failed.push({
                    name,
                    detail: caught instanceof Error ? caught.message : "Cloudflare rejected the record"
                });
            }
        }
    }
    return result;
}
