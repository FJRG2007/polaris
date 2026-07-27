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
import {
    getDomainZones,
    saveDomainZones,
    setDashboardZoneIntent,
    zoneDnsVerified,
    zoneRecords,
    type DomainZoneConfig
} from "@/lib/domain-zones";
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
import { normalizeBaseDomain } from "@polaris/deploy";

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
    // Records created at a registrar take minutes to propagate, so the check that runs
    // on save usually fails and the layout stays unproven - and an unproven zone hands
    // out no hostnames. Opening the setup re-proves it, rather than leaving the
    // operator to guess that a button on the last step is what unblocks their domain.
    const saved = await getDomainZones();
    if (saved.baseDomain && !(await zoneDnsVerified())) await checkZoneDns().catch(() => undefined);
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

    // The domain a wildcard strategy builds zones on: the operator's own, or the
    // DuckDNS name Polaris keeps pointed at this server. A tunnel strategy stores
    // none - its hostnames are published by the tunnel provider, so a zone here
    // would ask the operator to create DNS records that must not exist.
    const duckSubdomain = parsed.data.duckdnsSubdomain.trim().toLowerCase();
    const baseDomain =
        strategy === "duckdns"
            ? duckSubdomain && `${duckSubdomain}.duckdns.org`
            : meta.wildcard && meta.needsDomain
              ? normalizeBaseDomain(parsed.data.baseDomain)
              : "";
    // Everything is validated before the first write: a strategy that needs a domain
    // and does not get one would otherwise store the exposure mode "wildcard" with no
    // wildcard domain, which mints LAN-only hostnames on a perfectly public server -
    // a worse state than before the wizard ran. Half-applied answers are the other
    // failure this prevents: the environment used to be saved even on this error.
    if (strategy === "duckdns" && !duckSubdomain) {
        return { state: await domainSetupStateAction(), error: "Enter your DuckDNS subdomain" };
    }
    if (meta.needsDomain && meta.wildcard && !baseDomain) {
        return { state: await domainSetupStateAction(), error: "Enter the domain you want to use" };
    }

    try {
        await setLocalEnvironment(environment);

        if (strategy === "duckdns") {
            await setDomainConfig({
                duckdnsSubdomain: duckSubdomain,
                ...(parsed.data.duckdnsToken.trim() ? { duckdnsToken: parsed.data.duckdnsToken.trim() } : {})
            });
        }

        const zones = await saveDomainZones({ baseDomain, zones: parsed.data.zones });
        // The standalone wildcard field is cleared: from here the zone layout is the
        // only thing that names a wildcard domain, so a value left over from an earlier
        // setup cannot keep exposing services on a domain the operator just dropped.
        await setNetworkConfig({ mode: meta.mode, wildcardDomain: "" });

        // The dashboard only moves onto the new domain when the operator asked for it
        // and the strategy actually serves the zone: a wrong app domain breaks every
        // link Polaris hands out, including the one they are reading this on. A tunnel
        // exposes one hostname at a time, so its domain never becomes the app URL here.
        // Recorded as an intention - the DNS check below carries it out, and only if
        // the zone is actually answering by then.
        await setDashboardZoneIntent(useForDashboard && Boolean(zones.baseDomain) && meta.wildcard);

        // A fresh DuckDNS record is useless until it points somewhere; do it now
        // rather than waiting for the next sync tick.
        if (strategy === "duckdns") await syncDuckDns().catch(() => undefined);

        // Prove the layout straight away instead of leaving it unverified until someone
        // presses a button on the last step - a DuckDNS wildcard, which needs no records
        // at all, would otherwise never be marked as resolving, and every share link
        // would keep falling back to a tunnel for a domain that already works.
        if (zones.baseDomain) await checkZoneDns().catch(() => undefined);

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

const provisionSchema = z.object({ overwrite: z.boolean().default(false) });

/**
 * Create the zone + wildcard records through the connected Cloudflare account. Names
 * that already point elsewhere come back as conflicts and are only repointed on a
 * second call with `overwrite`, once the operator has seen what would be replaced.
 */
export async function provisionZoneDnsAction(input?: unknown): Promise<ZoneDnsProvisionResult & { error?: string }> {
    const user = await requireAdmin();
    const overwrite = provisionSchema.safeParse(input ?? {}).data?.overwrite ?? false;
    try {
        const result = await provisionZoneDns({ overwrite });
        await recordAudit({
            actorId: user.id,
            action: "domains.dns.provision",
            targetType: "setting",
            targetId: overwrite ? "zones:overwrite" : "zones"
        });
        return result;
    } catch (caught) {
        return {
            created: [],
            replaced: [],
            conflicts: [],
            failed: [],
            error: caught instanceof Error ? caught.message : "Could not create the DNS records"
        };
    }
}
