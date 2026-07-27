"use server";

/**
 * Guided domain-setup actions. The wizard collects three answers - where this server
 * lives, how services should be exposed, and which domain and zones to use - and this
 * applies them in one place, so the exposure mode, the zone layout and the DuckDNS
 * credentials can never drift apart the way they do when each is saved on its own.
 *
 * Admin-gated: these change every URL Polaris hands out.
 */

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { serverEnvironmentSchema } from "@polaris/core";
import { requireAdmin } from "@/lib/session";
import { recordAudit } from "@/lib/audit-service";
import { checkZoneDns, provisionZoneDns, type ZoneDnsProvisionResult, type ZoneDnsReport } from "@/lib/domain-dns";
import { getDomainZones, saveDomainZones, zoneRecords, type DomainZoneConfig } from "@/lib/domain-zones";
import { getCloudflareAccountStatus } from "@/lib/integrations/cloudflare-account-service";
import { EXPOSURE_STRATEGIES, STRATEGY_META, type ExposureStrategy } from "@/lib/domain-strategies";
import { getDomainConfig, setDomainConfig, syncDuckDns, type DomainConfig } from "@/lib/domain-service";
import {
    getLocalEnvironment,
    getNetworkStatus,
    setLocalEnvironment,
    setNetworkConfig,
    type LocalEnvironment,
    type NetworkStatus
} from "@/lib/network-service";
import { zoneHost } from "@polaris/deploy";

export interface DomainSetupState {
    environment: LocalEnvironment;
    network: NetworkStatus;
    zones: DomainZoneConfig;
    domains: DomainConfig;
    /** Whether a Cloudflare API token is connected, so DNS can be created for the operator. */
    cloudflareConnected: boolean;
    /** The DNS records the current layout needs. */
    records: Array<{ host: string; wildcard: string; scope: string }>;
}

/** Everything the wizard renders from, in one round trip. */
export async function domainSetupStateAction(): Promise<DomainSetupState> {
    await requireAdmin();
    const [environment, network, zones, domains, cloudflare] = await Promise.all([
        getLocalEnvironment(),
        getNetworkStatus(),
        getDomainZones(),
        getDomainConfig(),
        getCloudflareAccountStatus()
    ]);
    return {
        environment,
        network,
        zones,
        domains,
        cloudflareConnected: cloudflare.connected,
        records: zoneRecords(zones).map((record) => ({
            host: record.host,
            wildcard: record.wildcard,
            scope: record.zone.scope
        }))
    };
}

const setupSchema = z.object({
    environment: serverEnvironmentSchema,
    strategy: z.enum(EXPOSURE_STRATEGIES as [ExposureStrategy, ...ExposureStrategy[]]),
    baseDomain: z.string().default(""),
    zones: z
        .array(z.object({ label: z.string(), scope: z.enum(["polaris", "deploy"]), primary: z.boolean() }))
        .default([]),
    duckdnsSubdomain: z.string().default(""),
    duckdnsToken: z.string().default(""),
    /** Point the dashboard's own URL at the Polaris zone as well. */
    useForDashboard: z.boolean().default(true)
});

export interface DomainSetupResult {
    state: DomainSetupState;
    error?: string;
}

/**
 * Apply the wizard's answers. The strategy decides what a domain means here: a
 * wildcard strategy stores the zone layout and switches exposure to it, a tunnel
 * strategy keeps the domain for per-service tunnel hostnames, and the free-subdomain
 * strategy clears the domain so nothing claims DNS that was never created.
 */
export async function saveDomainSetupAction(input: unknown): Promise<DomainSetupResult> {
    const user = await requireAdmin();
    const parsed = setupSchema.safeParse(input);
    if (!parsed.success) {
        return { state: await domainSetupStateAction(), error: parsed.error.issues[0]?.message ?? "Invalid setup" };
    }
    const { strategy, environment, useForDashboard } = parsed.data;
    const meta = STRATEGY_META[strategy];

    try {
        await setLocalEnvironment(environment);

        if (strategy === "duckdns") {
            const subdomain = parsed.data.duckdnsSubdomain.trim().toLowerCase();
            if (!subdomain) throw new Error("Enter your DuckDNS subdomain");
            await setDomainConfig({
                duckdnsSubdomain: subdomain,
                ...(parsed.data.duckdnsToken.trim() ? { duckdnsToken: parsed.data.duckdnsToken.trim() } : {})
            });
        }

        // The domain a wildcard strategy builds zones on: the operator's own, or the
        // DuckDNS name Polaris keeps pointed at this server. A tunnel strategy stores
        // none - its hostnames are published by the tunnel provider, so a zone here
        // would ask the operator to create DNS records that must not exist.
        const baseDomain =
            strategy === "duckdns"
                ? `${parsed.data.duckdnsSubdomain.trim().toLowerCase()}.duckdns.org`
                : meta.wildcard && meta.needsDomain
                  ? parsed.data.baseDomain
                  : "";
        const zones = await saveDomainZones({ baseDomain, zones: parsed.data.zones });
        // The standalone wildcard field is cleared: from here the zone layout is the
        // only thing that names a wildcard domain, so a value left over from an earlier
        // setup cannot keep exposing services on a domain the operator just dropped.
        await setNetworkConfig({ mode: meta.mode, wildcardDomain: "" });

        // The dashboard only moves onto the new domain when the operator asked for it
        // and the strategy actually serves the zone: a wrong app domain breaks every
        // link Polaris hands out, including the one they are reading this on. A tunnel
        // exposes one hostname at a time, so its domain never becomes the app URL here.
        if (useForDashboard && zones.baseDomain && meta.wildcard) {
            const polaris = zones.zones.find((zone) => zone.scope === "polaris");
            if (polaris) await setDomainConfig({ appDomain: zoneHost(polaris, zones.baseDomain) });
        }

        // A fresh DuckDNS record is useless until it points somewhere; do it now
        // rather than waiting for the next sync tick.
        if (strategy === "duckdns") await syncDuckDns().catch(() => undefined);

        await recordAudit({
            actorId: user.id,
            action: "domains.setup",
            targetType: "setting",
            targetId: strategy
        });
        revalidatePath("/admin/domains");
        return { state: await domainSetupStateAction() };
    } catch (caught) {
        return {
            state: await domainSetupStateAction(),
            error: caught instanceof Error ? caught.message : "Could not save the domain setup"
        };
    }
}

/** Resolve each zone's wildcard and report what it points at. */
export async function checkZoneDnsAction(): Promise<ZoneDnsReport> {
    await requireAdmin();
    return checkZoneDns();
}

/** Create the zone + wildcard records through the connected Cloudflare account. */
export async function provisionZoneDnsAction(): Promise<ZoneDnsProvisionResult & { error?: string }> {
    const user = await requireAdmin();
    try {
        const result = await provisionZoneDns();
        await recordAudit({ actorId: user.id, action: "domains.dns.provision", targetType: "setting", targetId: "zones" });
        return result;
    } catch (caught) {
        return {
            created: [],
            failed: [],
            error: caught instanceof Error ? caught.message : "Could not create the DNS records"
        };
    }
}
