"use server";

/**
 * Guided domain-setup actions. The wizard collects three answers - where this server
 * lives, how services should be exposed, and which domain and zones to use - and this
 * applies them in one place, so the exposure mode, the zone layout and the DuckDNS
 * credentials can never drift apart the way they do when each is saved on its own.
 * The chosen strategy is recorded alongside them, because what a strategy leaves
 * behind does not identify it well enough to reopen the setup on the right answer.
 *
 * Reading is served from here too: the state the wizard renders from, and the lookup
 * of who answers DNS for a domain as it is typed.
 *
 * Admin-gated: these change every URL Polaris hands out.
 */

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/session";
import { getHostLanIp } from "@/lib/host-address";
import { recordAudit } from "@/lib/audit-service";
import { syncDashboardRoute } from "@/lib/domain-edge";
import { installedGames } from "@/lib/apps/game-zones";
import { serverEnvironmentSchema } from "@polaris/core";
import { listGamePorts } from "@/lib/apps/games-service";
import { getSetting, setSetting } from "@/lib/setting-store";
import type { PortBlocks, PortPolicy } from "@/lib/apps/port-block";
import { getPortBlocks, getPortPolicy } from "@/lib/apps/port-block-store";
import { detectDnsProvider, type DnsProviderInfo } from "@/lib/dns-provider";
import { isBaseDomain, isZoneLabel, normalizeBaseDomain } from "@polaris/deploy";
import { getCloudflareAccountStatus } from "@/lib/integrations/cloudflare-account-service";
import { EXPOSURE_STRATEGIES, STRATEGY_META, type ExposureStrategy } from "@/lib/domain-strategies";
import { getDomainConfig, setDomainConfig, syncDuckDns, type DomainConfig } from "@/lib/domain-service";
import { checkZoneDns, provisionZoneDns, type ZoneDnsProvisionResult, type ZoneDnsReport } from "@/lib/domain-dns";
import {
    getLocalEnvironment,
    getNetworkStatus,
    setLocalEnvironment,
    setNetworkConfig,
    type LocalEnvironment,
    type NetworkStatus
} from "@/lib/network-service";
import {
    gameZoneRecords,
    getDomainZones,
    saveDomainZones,
    setDashboardZoneIntent,
    zoneDnsVerified,
    zoneRecords,
    type DomainZoneConfig
} from "@/lib/domain-zones";

/** The strategy the setup last saved. Its own key because nothing else records it. */
const STRATEGY_KEY = "domain.setup.strategy";

export interface DomainSetupState {
    environment: LocalEnvironment;
    network: NetworkStatus;
    zones: DomainZoneConfig;
    domains: DomainConfig;
    /**
     * What the operator chose last time, or null for a layout saved before this was
     * recorded. Kept because the side effects a strategy leaves behind cannot tell
     * them apart: both tunnels store the exposure mode "tunnel" and no domain, and a
     * free subdomain stores exactly what an unconfigured box holds - so reopening the
     * setup would offer an account the operator never connected, or the environment's
     * recommendation in place of the answer they gave.
     */
    strategy: ExposureStrategy | null;
    /** Whether a Cloudflare API token is connected, so DNS can be created for the operator. */
    cloudflareConnected: boolean;
    /** Whether that token also reaches an account, which is what named tunnels need. */
    cloudflareTunnelReady: boolean;
    /** This server's address on the LAN, which is what a port forward has to point at.
     *  Null where it is not published, and then the router steps say so rather than
     *  naming an address that would send the operator to the wrong machine. */
    lanIp: string | null;
    /** The DNS records the current layout needs. */
    records: Array<{ host: string; wildcard: string; scope: string }>;
    /**
     * One wildcard per installed game, listed apart from the zones because it is not
     * one: it needs no host record, and a missing one does not make the layout
     * unverified. What it costs to skip is a DNS record per game server, which is what
     * fills a zone up on a deployment that runs a lot of them.
     */
    gameRecords: Array<{ game: string; wildcard: string }>;
    /**
     * Game servers and the ports they answer on. Part of this screen because it is
     * the screen that asks an operator to open ports at all: 80 and 443 carry every
     * website and no game client, so a deployment running game servers needs rules
     * nothing else here would ever mention.
     */
    gameServers: Array<{ name: string; ports: Array<{ port: number; protocol: "tcp" | "udp" }>; confirmed: boolean }>;
    /** How those ports are opened - a rule each, or one range per transport - and
     *  the ranges themselves, which is what the rules are written from. */
    portPolicy: PortPolicy;
    portBlocks: PortBlocks;
}

/** Everything the wizard renders from, in one round trip. */
export async function domainSetupStateAction(): Promise<DomainSetupState> {
    await requireAdmin();
    return domainSetupState();
}

/** The same, without the permission check, for callers already inside one. */
async function domainSetupState(): Promise<DomainSetupState> {
    // Records created at a registrar take minutes to propagate, so the check that runs
    // on save usually fails and the layout stays unproven - and an unproven zone hands
    // out no hostnames. Opening the setup re-proves it, rather than leaving the
    // operator to guess that a button on the last step is what unblocks their domain.
    const saved = await getDomainZones();
    if (saved.baseDomain && !(await zoneDnsVerified())) await checkZoneDns().catch(() => undefined);
    const [environment, network, zones, domains, cloudflare, strategy, lanIp, gameServers, portPolicy, portBlocks, games] =
        await Promise.all([
            getLocalEnvironment(),
            getNetworkStatus(),
            getDomainZones(),
            getDomainConfig(),
            getCloudflareAccountStatus(),
            getSetting(STRATEGY_KEY),
            getHostLanIp(),
            // Best effort: the domain setup must open with or without the game servers,
            // and a deployment that has none is the common case.
            listGamePorts().catch(() => []),
            getPortPolicy(),
            getPortBlocks(),
            installedGames().catch(() => [])
        ]);
    return {
        environment,
        network,
        zones,
        domains,
        // Validated like any other stored value: a key written by a version that knew
        // a strategy this one does not would otherwise preselect an option that no
        // longer exists, leaving step 2 with nothing highlighted.
        strategy: EXPOSURE_STRATEGIES.includes(strategy as ExposureStrategy) ? (strategy as ExposureStrategy) : null,
        // The records need the token and nothing else, so a zone-scoped token counts
        // as connected here even though it reaches no account.
        cloudflareConnected: cloudflare.dnsReady,
        cloudflareTunnelReady: cloudflare.connected,
        lanIp,
        portPolicy,
        portBlocks,
        gameServers: gameServers.map((server) => ({
            name: server.name,
            ports: server.ports.map((port) => ({ port: port.port, protocol: port.protocol })),
            confirmed: server.confirmed
        })),
        records: zoneRecords(zones).map((record) => ({
            host: record.host,
            wildcard: record.wildcard,
            scope: record.zone.scope
        })),
        gameRecords: gameZoneRecords(zones, games).map((record) => ({
            game: record.game,
            wildcard: record.wildcard
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
 * Apply the wizard's answers. Only a wildcard strategy owns a domain here: it stores
 * the zone layout and switches exposure to it. A tunnel or free-subdomain strategy
 * clears the stored domain - their hostnames come from the tunnel provider or from
 * sslip.io, so a zone would claim DNS that was never created. Re-running the setup
 * and choosing one of those therefore drops a layout saved earlier, which is the
 * intended reading of "this is how the box is exposed now".
 */
export async function saveDomainSetupAction(input: unknown): Promise<DomainSetupResult> {
    const user = await requireAdmin();
    // Read once, and reuse it on every path that rejects the input: the read is not
    // free (DNS, an HTTP probe per zone, a public-IP lookup) and none of that changes
    // because the operator mistyped something.
    const current = await domainSetupState();
    const parsed = setupSchema.safeParse(input);
    if (!parsed.success) {
        return { state: current, error: parsed.error.issues[0]?.message ?? "Invalid setup" };
    }
    const { strategy, environment, useForDashboard } = parsed.data;
    const meta = STRATEGY_META[strategy];

    // The domain a wildcard strategy builds zones on: the operator's own, or the
    // DuckDNS name Polaris keeps pointed at this server. A tunnel strategy stores
    // none - its hostnames are published by the tunnel provider, so a zone here
    // would ask the operator to create DNS records that must not exist.
    // DuckDNS shows the operator the full name, so pasting "mypolaris.duckdns.org" is
    // the natural move - and concatenating it would store mypolaris.duckdns.org.duckdns.org
    // as the zone base and the sync target, both wrong with nothing to show for it.
    const duckSubdomain = parsed.data.duckdnsSubdomain
        .trim()
        .toLowerCase()
        .replace(/\.duckdns\.org\.?$/, "");
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
    // Validation answers with the state the caller already has: re-reading it here
    // would pay for DNS lookups, an HTTP probe per zone and a public-IP round trip
    // before showing the operator that they mistyped a domain.
    if (strategy === "duckdns") {
        // An empty label is a valid ZONE label (it means the base domain itself), so
        // it has to be rejected on its own - otherwise a blank field saves a layout
        // with no domain under a strategy whose whole point is the domain.
        if (!duckSubdomain || !isZoneLabel(duckSubdomain)) {
            return {
                state: current,
                error: duckSubdomain ? "Enter just the subdomain, e.g. mypolaris" : "Enter your DuckDNS subdomain"
            };
        }
        // Without a token nothing can update the record, so the setup would report
        // success while the name points wherever DuckDNS last had it - and the DNS
        // step would promise Polaris keeps it up to date.
        if (!current.domains.hasDuckdnsToken && !parsed.data.duckdnsToken.trim()) {
            return { state: current, error: "Enter your DuckDNS token so Polaris can keep the record updated" };
        }
    }
    if (meta.needsDomain && meta.wildcard && !baseDomain) {
        return { state: current, error: "Enter the domain you want to use" };
    }

    try {
        await setLocalEnvironment(environment);
        // The answer itself, not just what it stores: reopening the setup reads this
        // back, so a strategy that leaves the same traces as another one still comes
        // back as the one that was chosen.
        await setSetting(STRATEGY_KEY, strategy);

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

        // Serve the zone before anything checks whether it is being served. The
        // reachability probe below - and the dashboard move it can trigger - both ask
        // whether traffic for the zone arrives here, which it cannot until the edge
        // has a route for the name.
        await syncDashboardRoute();

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

const detectSchema = z.object({ domain: z.string().min(1).max(253) });

/**
 * Who answers DNS for a domain the operator is typing. Answers null rather than
 * throwing for anything unresolvable: this only decides which shortcut the setup
 * offers, and a domain that does not exist yet is the normal case while typing.
 */
export async function detectDnsProviderAction(input: unknown): Promise<DnsProviderInfo | null> {
    await requireAdmin();
    const parsed = detectSchema.safeParse(input);
    if (!parsed.success) return null;
    const domain = normalizeBaseDomain(parsed.data.domain);
    if (!isBaseDomain(domain)) return null;
    return detectDnsProvider(domain).catch(() => null);
}

/** Resolve each zone's wildcard and report what it points at. Asked for by hand,
 *  so this server's own address is re-detected rather than remembered - the
 *  operator pressing this has usually just changed the thing being compared. */
export async function checkZoneDnsAction(): Promise<ZoneDnsReport> {
    await requireAdmin();
    return checkZoneDns({ fresh: true });
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
            unchanged: [],
            conflicts: [],
            failed: [],
            error: caught instanceof Error ? caught.message : "Could not create the DNS records"
        };
    }
}
