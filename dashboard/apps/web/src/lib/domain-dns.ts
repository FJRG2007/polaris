/**
 * Proof that the DNS the guided setup asked for actually exists, and - when the
 * operator has connected a Cloudflare API token - the ability to create it for them.
 *
 * The check resolves both names a zone needs, because the half-done setup goes wrong
 * in either direction: a random label proves the WILDCARD answers (nothing else could
 * answer for a name nobody ever created), and the zone host itself is checked on its
 * own, since no wildcard covers it and it is exactly what the dashboard URL and share
 * links are built from.
 *
 * Resolving is not the same as being reachable, though: on a home line the record
 * points at the router, which answers DNS for the whole house whether or not 80/443
 * were ever forwarded here. So the hostname is also asked for an HTTP answer - any
 * answer - and the outcome is recorded as a SECOND, separate flag. It has to be
 * separate, because the request leaves this box: plenty of routers will not send it
 * back to their own public address, and a domain that works perfectly from the
 * internet would look dead from the inside. Correct DNS is therefore what lets
 * Polaris mint hostnames; an answer on the wire is what lets it hand links to other
 * people and stand the fallback tunnel down.
 */

import { resolve4 } from "node:dns/promises";
import { randomLabel } from "@polaris/deploy";
import {
    getDashboardZoneIntent,
    getDomainZones,
    polarisZoneHost,
    setDashboardZoneIntent,
    setZoneDnsVerified,
    setZoneReachable,
    zoneRecords
} from "./domain-zones";
import { setDomainConfig } from "./domain-service";
import { detectPublicIp, getLocalEnvironment } from "./network-service";
import { reportRouterAdvice, type RouterAdvice } from "./network-advice";
import { loadCloudflareToken } from "./integrations/cloudflare-account-service";
import { findDnsRecords, pruneDnsRecords, resolveZoneForHostname, upsertARecord } from "./integrations/cloudflare-api";

export interface ZoneDnsCheck {
    /** The zone's own hostname (`plr.example.com`). */
    host: string;
    /** The wildcard record the zone needs. */
    wildcard: string;
    /** What a name inside the zone resolves to today. */
    addresses: string[];

    /** True when both of the zone's names resolve to this server. */
    ok: boolean;
    /** True when something answered on the hostname from here (see the probe). */
    reachable: boolean;
    detail: string;
}

export interface ZoneDnsReport {
    /** The address the records should point at, when one is known. */
    expectedIp: string | null;
    zones: ZoneDnsCheck[];
    /** What is left to do outside Polaris - a router forward, a firewall rule - for
     *  the domain to work. Null when there is no Polaris zone to diagnose. */
    router: RouterAdvice | null;
}

/** Resolve one name, returning an empty list rather than throwing on NXDOMAIN. */
async function resolveOrEmpty(hostname: string): Promise<string[]> {
    try {
        return await resolve4(hostname);
    } catch {
        return [];
    }
}

/** Check both names a zone needs - its wildcard and its own host - against this
 *  server's public IP, and whether the hostname actually serves Polaris. */
export async function checkZoneDns(): Promise<ZoneDnsReport> {
    const [config, expectedIp] = await Promise.all([getDomainZones(), detectPublicIp()]);
    const records = zoneRecords(config);
    const zones = await Promise.all(
        records.map(async (record) => {
            const [wildcardAddresses, hostAddresses] = await Promise.all([
                resolveOrEmpty(`${randomLabel(3)}.${record.host}`),
                resolveOrEmpty(record.host)
            ]);
            const missing = [
                wildcardAddresses.length === 0 ? record.wildcard : null,
                hostAddresses.length === 0 ? record.host : null
            ].filter((name): name is string => name !== null);
            const addresses = [...new Set([...wildcardAddresses, ...hostAddresses])];
            if (missing.length > 0) {
                return {
                    host: record.host,
                    wildcard: record.wildcard,
                    addresses,
                    ok: false,
                    reachable: false,
                    detail: `No DNS answer for ${missing.join(" or ")} yet. Records can take a few minutes to propagate.`
                };
            }
            // Without a known public IP the records cannot be compared, only confirmed
            // to exist - which is still the useful half of the answer.
            const elsewhere = expectedIp
                ? [...wildcardAddresses, ...hostAddresses].filter((address) => address !== expectedIp)
                : [];
            if (elsewhere.length > 0) {
                return {
                    host: record.host,
                    wildcard: record.wildcard,
                    addresses,
                    ok: false,
                    reachable: false,
                    detail: `Resolves to ${addresses.join(", ")}, but this server is at ${expectedIp}.`
                };
            }
            // DNS pointing here is not the same as traffic arriving here: on a home
            // line it is the router that answers, and nothing so far says 80/443 reach
            // this box. Asked separately, and never used to fail the zone - the probe
            // leaves this machine, and a router that does not loop a request back to
            // its own WAN address would make a perfectly working domain look dead.
            const reachable = await answersHere(record.host);
            return {
                host: record.host,
                wildcard: record.wildcard,
                addresses,
                ok: true,
                reachable,
                detail: reachable
                    ? `Resolves to ${addresses.join(", ")} and answers here.`
                    : `Resolves to ${addresses.join(", ")}. Nothing answered on it from this side - fine if your router does not route its own public address back inward, otherwise check that ports 80 and 443 reach this server.`
            };
        })
    );
    // "Verified" has to mean "seen resolving HERE", so it is only recorded when the
    // server's own address is known to compare against: without it, a wildcard
    // pointing at a completely different machine would look like proof.
    if (expectedIp) {
        const verified = zones.length > 0 && zones.every((zone) => zone.ok);
        await setZoneDnsVerified(verified);
        // Handing a link to someone else asks for more than correct DNS, so the two
        // are recorded apart: this one is what moves the dashboard's URL and stands
        // the fallback tunnel down.
        const reachable = verified && zones.every((zone) => zone.reachable);
        await setZoneReachable(reachable);
        if (reachable) await applyDashboardZone();
    }
    // Only diagnose the router once the records themselves are right. Before that the
    // name resolves nowhere, so nothing could answer on it - and the operator would be
    // sent to their router over what is actually a missing DNS record.
    const resolves = zones.length > 0 && zones.every((zone) => zone.ok);
    return { expectedIp, zones, router: resolves ? await checkRouter() : null };
}

/**
 * Diagnose what is still in the way of the domain, on the one hostname the dashboard
 * itself serves - so the probe can ask who answered instead of settling for the fact
 * that somebody did.
 *
 * Best-effort: this is advice, and a failure here must not fail the DNS check the
 * operator actually pressed the button for.
 */
async function checkRouter(): Promise<RouterAdvice | null> {
    try {
        const host = await polarisZoneHost();
        if (!host) return null;
        const { environment } = await getLocalEnvironment();
        return await reportRouterAdvice(environment, host);
    } catch {
        return null;
    }
}

/**
 * Whether an HTTP request to the hostname is answered at all. Any status counts,
 * including the edge's own 404: a zone host is not a site Polaris serves - deployed
 * services live *under* it - so demanding a particular response would be demanding
 * something that by design does not exist. What is being established is that packets
 * for that name arrive at this box's port 80, which a refused connection or a timeout
 * rules out and any answer confirms.
 *
 * Plain HTTP on purpose: the certificate for the name cannot exist until the name
 * works, so requiring HTTPS would fail for the very setup this confirms.
 */
async function answersHere(hostname: string): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
        await fetch(`http://${hostname}/`, {
            cache: "no-store",
            redirect: "manual",
            signal: controller.signal
        });
        return true;
    } catch {
        return false;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Move the dashboard onto the Polaris zone, once the setup asked for it and the zone
 * has just been proven to resolve here. Every URL Polaris hands out is built from the
 * app domain, so writing it the moment the wizard is saved points invites, notification
 * links and the dashboard's own link at a name that does not exist until the operator
 * creates the records - this is the same gate `sharingBaseUrl` applies. One-shot: the
 * intention is cleared once carried out, and re-stated by the next guided setup.
 */
async function applyDashboardZone(): Promise<void> {
    if (!(await getDashboardZoneIntent())) return;
    const host = await polarisZoneHost();
    // The layout may no longer have a Polaris zone (the operator can remove it), and a
    // standing intention that can never be carried out would sit there forever, silently
    // doing nothing on every future check. Drop it instead - the wizard only offers the
    // choice while such a zone exists.
    if (!host) {
        await setDashboardZoneIntent(false);
        return;
    }
    await setDomainConfig({ appDomain: host });
    await setDashboardZoneIntent(false);
}

export interface ZoneDnsProvisionResult {
    created: string[];
    /** Records that already existed and were repointed at this server. */
    replaced: string[];
    /** Names that already pointed here, so nothing had to be done. */
    unchanged: string[];
    /** Records pointing somewhere else, left untouched until the operator confirms. */
    conflicts: Array<{ name: string; content: string }>;
    failed: Array<{ name: string; detail: string }>;
}

/**
 * Create the zone and wildcard A records through the connected Cloudflare account,
 * so an operator whose domain is already on Cloudflare never opens its dashboard.
 * Idempotent: a record that already points here is left as it is. Throws when there
 * is no token, no domain, or no detectable public IP - each with what to do about it.
 *
 * A record that points somewhere else is never touched without `overwrite`: a zone
 * with an empty label puts the operator's apex (`example.com`) on this list, and
 * repointing that would take their existing website offline. They are reported back
 * so the caller can name them and ask.
 */
export async function provisionZoneDns(options: { overwrite?: boolean } = {}): Promise<ZoneDnsProvisionResult> {
    const [config, token, ip] = await Promise.all([getDomainZones(), loadCloudflareToken(), detectPublicIp()]);
    if (!config.baseDomain) throw new Error("Set a base domain first");
    if (!token) throw new Error("Connect a Cloudflare API token under Integrations first");
    if (!ip) throw new Error("Polaris could not detect this server's public IP, so it does not know what to point DNS at");

    const zone = await resolveZoneForHostname(token, config.baseDomain);
    const result: ZoneDnsProvisionResult = { created: [], replaced: [], unchanged: [], conflicts: [], failed: [] };
    // Sequential on purpose: Cloudflare rate-limits per account, and a handful of
    // records is not worth risking a 429 that leaves the layout half-created.
    for (const record of zoneRecords(config)) {
        for (const name of [record.host, record.wildcard]) {
            try {
                const existing = await findDnsRecords(token, zone.id, "A", name);
                // Every address the name answers with has to be this server: one stray
                // record left in place keeps the name round-robining onto a machine
                // that does not serve the app.
                const elsewhere = existing.filter((entry) => entry.content !== ip);
                if (existing.length > 0 && elsewhere.length === 0) {
                    result.unchanged.push(name);
                    continue;
                }
                if (elsewhere.length > 0 && !options.overwrite) {
                    result.conflicts.push({ name, content: elsewhere.map((entry) => entry.content).join(", ") });
                    continue;
                }
                const recordId = await upsertARecord(token, zone.id, name, ip);
                await pruneDnsRecords(token, zone.id, recordId, existing);
                (existing.length > 0 ? result.replaced : result.created).push(name);
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

/** What became of the DNS for one custom hostname, so the caller can say whether
 *  anything is still left to do by hand. */
export interface HostnameDnsResult {
    /**
     * `created` - a record now points the name at this server.
     * `unchanged` - it already resolved here, or its record already pointed here.
     * `conflict` - a record exists and answers elsewhere; it was left alone.
     * `manual` - nothing was written, and `detail` says why.
     */
    status: "created" | "unchanged" | "conflict" | "manual";
    /** The address the name should answer with, when this server knows its own. */
    ip: string | null;
    /** Where the existing record points, for `conflict`. */
    content?: string;
    /** Why nothing was written, for `manual`. */
    detail?: string;
}

/**
 * Point one hostname at this server through the connected Cloudflare account, so a
 * custom domain needs no visit to a DNS panel. This is what lets a service take any
 * name at all - one directly on the operator's own domain as readily as one on a
 * different domain entirely - without the wildcard record a deploy zone relies on.
 *
 * A record pointing somewhere else is never overwritten: the name may be a live site,
 * and repointing it would take it offline. It is reported back instead. Nothing here
 * throws - the domain is added either way, and DNS that is not there yet only delays
 * the certificate.
 */
export async function provisionHostnameDns(hostname: string): Promise<HostnameDnsResult> {
    const name = hostname.trim().toLowerCase();
    const [token, ip] = await Promise.all([loadCloudflareToken(), detectPublicIp()]);
    if (!ip) {
        return {
            status: "manual",
            ip: null,
            detail: "Polaris could not detect this server's public IP, so it does not know what to point DNS at."
        };
    }
    // Asked of DNS before Cloudflare: a name a wildcard already covers needs no record
    // of its own, and one lookup is cheaper than a round trip to the API.
    if ((await resolveOrEmpty(name)).includes(ip)) return { status: "unchanged", ip };
    if (!token) {
        return {
            status: "manual",
            ip,
            detail: "No Cloudflare API token is connected, so Polaris cannot write the record for you."
        };
    }
    try {
        const zone = await resolveZoneForHostname(token, name);
        const existing = await findDnsRecords(token, zone.id, "A", name);
        const elsewhere = existing.filter((entry) => entry.content !== ip);
        if (existing.length > 0 && elsewhere.length === 0) return { status: "unchanged", ip };
        if (elsewhere.length > 0) {
            return { status: "conflict", ip, content: elsewhere.map((entry) => entry.content).join(", ") };
        }
        const recordId = await upsertARecord(token, zone.id, name, ip);
        await pruneDnsRecords(token, zone.id, recordId, existing);
        return { status: "created", ip };
    } catch (caught) {
        return {
            status: "manual",
            ip,
            detail: caught instanceof Error ? caught.message : "Cloudflare rejected the record."
        };
    }
}
