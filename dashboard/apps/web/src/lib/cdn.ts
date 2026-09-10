/**
 * Serving a service's domain through Cloudflare's proxy, which caches its static
 * assets at Cloudflare's edge, and emptying that cache when a new release goes
 * live.
 *
 * Only possible for a hostname whose zone is on the Cloudflare account Polaris
 * is connected to: the proxy is a property of the DNS record, and Polaris can
 * only change records it can write. A name on sslip.io, on the LAN or on a
 * domain somewhere else has no record here to put behind anything, and the
 * toggle says so rather than pretending.
 *
 * Turning it on changes nothing about where the name points - the record keeps
 * its address, only `proxied` is set. A name answered until now by a wildcard
 * gets a record of its own with the wildcard's address, so proxying one name
 * never proxies every other name under the same wildcard.
 */

import { prisma } from "@polaris/db";
import { loadCloudflareToken } from "@/lib/integrations/cloudflare-account-service";
import {
    createAddressRecord,
    findAddressRecords,
    purgeCache,
    resolveZoneForHostname,
    setRecordProxied,
    zoneSslMode,
    type CfZone
} from "@/lib/integrations/cloudflare-api";

/** A refusal meant for the screen. */
export class CdnError extends Error {
    public constructor(message: string) {
        super(message);
        this.name = "CdnError";
    }
}

/** A tunnel's hostname is a CNAME onto the tunnel, which is always proxied. */
function isTunnelRecord(record: { type: string; content: string }): boolean {
    return record.type === "CNAME" && record.content.endsWith(".cfargotunnel.com");
}

async function cloudflareToken(): Promise<string> {
    const token = await loadCloudflareToken();
    if (!token) {
        throw new CdnError("Connect a Cloudflare account under Domains first - the domain's DNS has to be on Cloudflare.");
    }
    return token;
}

async function zoneFor(token: string, hostname: string): Promise<CfZone> {
    try {
        return await resolveZoneForHostname(token, hostname);
    } catch {
        throw new CdnError(
            `${hostname} is not on a domain in the connected Cloudflare account. Serving through Cloudflare needs the domain's DNS on Cloudflare.`
        );
    }
}

/** A domain of a service the owner holds. */
async function ownedDomain(domainId: string, ownerId: string) {
    const domain = await prisma.domain.findFirst({
        where: { id: domainId, application: { environment: { project: { ownerId } } } },
        select: { id: true, hostname: true, cdn: true, enabled: true, applicationId: true }
    });
    if (!domain) throw new CdnError("That domain is not there any more.");
    return domain;
}

/**
 * The wildcard records a name falls under, nearest first - `*.b.example.com`
 * before `*.example.com` for `a.b.example.com` - stopping at the zone.
 */
async function wildcardRecords(token: string, zone: CfZone, hostname: string) {
    const labels = hostname.split(".");
    for (let index = 1; index < labels.length; index += 1) {
        const parent = labels.slice(index).join(".");
        if (parent.length < zone.name.length) break;
        const records = await findAddressRecords(token, zone.id, `*.${parent}`);
        if (records.length > 0) return records;
    }
    return [];
}

/** Put a service domain behind Cloudflare's proxy, or take it out. */
export async function setDomainCdn(domainId: string, ownerId: string, enabled: boolean): Promise<void> {
    const domain = await ownedDomain(domainId, ownerId);
    const token = await cloudflareToken();
    const zone = await zoneFor(token, domain.hostname);
    const records = await findAddressRecords(token, zone.id, domain.hostname);

    if (enabled) {
        const mode = await zoneSslMode(token, zone.id);
        if (mode === "flexible" || mode === "off") {
            throw new CdnError(
                `${zone.name} is set to ${mode === "off" ? "no" : "Flexible"} SSL in Cloudflare, which would loop on this server's redirect to HTTPS. Set SSL/TLS to Full (strict) in Cloudflare for ${zone.name}, then turn this on.`
            );
        }
        if (records.length === 0) {
            const wildcard = await wildcardRecords(token, zone, domain.hostname);
            if (wildcard.length === 0) {
                throw new CdnError(`${domain.hostname} has no DNS record in Cloudflare yet, so there is nothing to put behind its proxy.`);
            }
            for (const record of wildcard) {
                await createAddressRecord(token, zone.id, {
                    type: record.type,
                    name: domain.hostname,
                    content: record.content,
                    proxied: true
                });
            }
        } else {
            for (const record of records) {
                if (!record.proxied) await setRecordProxied(token, zone.id, record.id, true);
            }
        }
    } else {
        for (const record of records) {
            if (record.proxied && !isTunnelRecord(record)) await setRecordProxied(token, zone.id, record.id, false);
        }
    }
    await prisma.domain.update({ where: { id: domain.id }, data: { cdn: enabled } });
}

/**
 * Empty the cache for hostnames, grouped into one call per zone. A prefix
 * narrows it to `hostname/prefix`; without one the whole hostname goes.
 */
async function purgeHostnames(hostnames: readonly string[], prefix?: string): Promise<void> {
    const token = await cloudflareToken();
    const byZone = new Map<string, string[]>();
    for (const hostname of hostnames) {
        const zone = await zoneFor(token, hostname);
        byZone.set(zone.id, [...(byZone.get(zone.id) ?? []), hostname]);
    }
    for (const [zoneId, names] of byZone) {
        for (let index = 0; index < names.length; index += 100) {
            const batch = names.slice(index, index + 100);
            try {
                await purgeCache(
                    token,
                    zoneId,
                    prefix ? { prefixes: batch.map((name) => `${name}/${prefix}`) } : { hosts: batch }
                );
            } catch (caught) {
                const said = caught instanceof Error ? caught.message : "";
                throw new CdnError(
                    /auth|permission|forbidden/i.test(said)
                        ? "The Cloudflare token cannot purge the cache. Give it the Zone - Cache Purge: Purge permission in Cloudflare."
                        : `Cloudflare refused the purge${said ? `: ${said}` : "."}`
                );
            }
        }
    }
}

/** The manual purge: one domain, whole or under a path. */
export async function purgeDomainCache(domainId: string, ownerId: string, prefix?: string): Promise<void> {
    const domain = await ownedDomain(domainId, ownerId);
    if (!domain.cdn) throw new CdnError("This domain is not served through Cloudflare, so there is no cache to empty.");
    await purgeHostnames([domain.hostname], prefix);
}

/**
 * After a release is promoted, empty the cache of every domain of the service
 * that is served through Cloudflare, so nobody is handed the previous release's
 * assets. A failure is logged and never fails the deploy - the release is live
 * either way, and the manual purge is there.
 */
export async function purgeAfterPromotion(applicationId: string): Promise<void> {
    try {
        const domains = await prisma.domain.findMany({
            where: { applicationId, cdn: true, enabled: true },
            select: { hostname: true }
        });
        if (domains.length === 0) return;
        await purgeHostnames(domains.map((domain) => domain.hostname));
    } catch (error) {
        console.error(
            `cdn: purging the cache after a release of ${applicationId} failed:`,
            error instanceof Error ? error.message : error
        );
    }
}
