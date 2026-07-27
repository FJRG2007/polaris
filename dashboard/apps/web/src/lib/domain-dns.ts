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
 * Resolving is not the same as serving, though. On a home line the wildcard points at
 * the router, which answers DNS for the whole house whether or not 80/443 are
 * forwarded here - so before the layout is called proven, Polaris asks the hostname
 * for its own health endpoint and requires its own answer.
 */

import { resolve4 } from "node:dns/promises";
import { randomLabel } from "@polaris/deploy";
import {
    getDashboardZoneIntent,
    getDomainZones,
    polarisZoneHost,
    setDashboardZoneIntent,
    setZoneDnsVerified,
    zoneRecords
} from "./domain-zones";
import { setDomainConfig } from "./domain-service";
import { detectPublicIp } from "./network-service";
import { loadCloudflareToken } from "./integrations/cloudflare-account-service";
import { findDnsRecords, pruneDnsRecords, resolveZoneForHostname, upsertARecord } from "./integrations/cloudflare-api";

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
                    detail: `Resolves to ${addresses.join(", ")}, but this server is at ${expectedIp}.`
                };
            }
            // DNS pointing here is not the same as traffic arriving here: on a home line
            // it is the router that answers, and nothing so far says 80/443 reach this
            // box. Ask the hostname for Polaris and require Polaris to answer.
            const reachable = await servesPolaris(record.host);
            return {
                host: record.host,
                wildcard: record.wildcard,
                addresses,
                ok: reachable,
                detail: reachable
                    ? `Resolves to ${addresses.join(", ")} and serves this Polaris.`
                    : `Resolves to ${addresses.join(", ")}, but nothing answers on it yet - check that ports 80 and 443 reach this server.`
            };
        })
    );
    // "Verified" has to mean "seen resolving HERE and serving this Polaris", so it is
    // only recorded when the server's own address is known to compare against:
    // without it, a wildcard pointing at a completely different machine would look
    // like proof and promote every share link onto it.
    if (expectedIp) {
        const verified = zones.length > 0 && zones.every((zone) => zone.ok);
        await setZoneDnsVerified(verified);
        if (verified) await applyDashboardZone();
    }
    return { expectedIp, zones };
}

/** Polaris's own readiness probe: unauthenticated, and it answers `{"status":"ok"}`,
 *  so an unrelated server holding the address does not pass for Polaris. */
const HEALTH_PATH = "/api/health";

/**
 * Whether the hostname reaches a Polaris over HTTP. Deliberately plain HTTP on the
 * public name: the certificate does not exist until the hostname works, so requiring
 * HTTPS here would fail for the very setup it is meant to confirm. What this rules
 * out is the case that matters - DNS pointed at a router with nothing forwarded, or
 * at a machine that serves something else entirely.
 */
async function servesPolaris(hostname: string): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
        const res = await fetch(`http://${hostname}${HEALTH_PATH}`, {
            cache: "no-store",
            redirect: "follow",
            signal: controller.signal
        });
        if (!res.ok) return false;
        const body = (await res.json().catch(() => null)) as { status?: unknown } | null;
        return body?.status === "ok";
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
