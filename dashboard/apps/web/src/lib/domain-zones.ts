/**
 * The operator's domain layout: one base domain plus the zones Polaris mints
 * hostnames under - `*.polaris.<base>` for Polaris's own services and `*.plr.<base>`
 * for deployed ones by default, plus any extra deploy zone the operator adds. Each
 * zone needs exactly one wildcard DNS record, so hostnames scale without touching
 * DNS again, and a zone with an empty label puts everything on the base domain
 * itself (`*.example.com`).
 *
 * Stored as one JSON Setting - this is configuration, not per-resource state, so it
 * needs no table - and validated on every read, so an older or hand-edited value can
 * never produce a malformed hostname.
 */

import { z } from "zod";
import {
    pickZone,
    zoneHost,
    isZoneLabel,
    zoneWildcard,
    defaultZones,
    isBaseDomain,
    zoneHostname,
    normalizeBaseDomain,
    randomZoneHostname,
    type DomainZone,
    type ZoneScope
} from "@polaris/deploy";
import { getSetting, setSetting } from "./setting-store";

const KEY = "domain.zones";

const zoneSchema = z.object({
    label: z.string().trim().toLowerCase().refine(isZoneLabel, "Use a single label like plr, or leave it empty"),
    scope: z.enum(["polaris", "deploy"]),
    primary: z.boolean().default(false)
});

/** What a caller may submit. The base domain is normalized before it is checked, so
 *  `https://Example.com/` and `*.example.com` are accepted as `example.com`. */
export const domainZoneInputSchema = z.object({
    baseDomain: z
        .string()
        .transform(normalizeBaseDomain)
        .refine((value) => value === "" || isBaseDomain(value), "Enter a domain like example.com"),
    zones: z.array(zoneSchema).max(24)
});

export interface DomainZoneConfig {
    /** Empty when no domain is configured - callers then fall back to free subdomains. */
    baseDomain: string;
    zones: DomainZone[];
}

/**
 * Keep the stored layout self-consistent: no two zones on the same hostname (they
 * would fight over the same wildcard), exactly one primary per scope, and a Polaris
 * zone always present so the control plane has somewhere to live.
 */
function reconcile(zones: DomainZone[]): DomainZone[] {
    const seen = new Set<string>();
    const unique = zones.filter((zone) => {
        if (seen.has(zone.label)) return false;
        seen.add(zone.label);
        return true;
    });
    const scopes: ZoneScope[] = ["polaris", "deploy"];
    return scopes.flatMap((scope) => {
        const scoped = unique.filter((zone) => zone.scope === scope);
        if (scoped.length === 0) return [];
        const primary = scoped.find((zone) => zone.primary) ?? scoped[0];
        return scoped.map((zone) => ({ ...zone, primary: zone === primary }));
    });
}

/** The configured layout, or the defaults when nothing has been saved yet. */
export async function getDomainZones(): Promise<DomainZoneConfig> {
    const raw = await getSetting(KEY);
    if (!raw) return { baseDomain: "", zones: defaultZones() };
    const parsed = domainZoneInputSchema.safeParse(safeJson(raw));
    // A value this version cannot read is treated as unset rather than trusted:
    // a malformed layout would mint hostnames that resolve nowhere.
    if (!parsed.success) return { baseDomain: "", zones: defaultZones() };
    const zones = reconcile(parsed.data.zones);
    return { baseDomain: parsed.data.baseDomain, zones: zones.length > 0 ? zones : defaultZones() };
}

function safeJson(raw: string): unknown {
    try {
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

/** Validate and store the layout. Throws a user-safe message on invalid input. */
export async function saveDomainZones(input: unknown): Promise<DomainZoneConfig> {
    const parsed = domainZoneInputSchema.safeParse(input);
    if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? "Invalid domain configuration");
    const zones = reconcile(parsed.data.zones);
    if (parsed.data.baseDomain && zones.every((zone) => zone.scope !== "deploy")) {
        throw new Error("Keep at least one zone for deployed services");
    }
    const config: DomainZoneConfig = { baseDomain: parsed.data.baseDomain, zones };
    await setSetting(KEY, JSON.stringify(config));
    return config;
}

/** Every zone as the pair of DNS names it needs, for the setup checklist. */
export interface ZoneRecords {
    zone: DomainZone;
    /** The zone's own hostname (`plr.example.com`). */
    host: string;
    /** The wildcard that covers every hostname Polaris mints in it. */
    wildcard: string;
}

export function zoneRecords(config: DomainZoneConfig): ZoneRecords[] {
    if (!config.baseDomain) return [];
    return config.zones.map((zone) => ({
        zone,
        host: zoneHost(zone, config.baseDomain),
        wildcard: zoneWildcard(zone, config.baseDomain)
    }));
}

/**
 * The wildcard base deployed services get their hostnames under (`plr.example.com`),
 * or null when no domain is configured. This is what makes the zone layout the single
 * source of truth for the exposure mode's wildcard domain.
 */
export async function deployZoneBase(label?: string): Promise<string | null> {
    const config = await getDomainZones();
    if (!config.baseDomain) return null;
    const zone = pickZone(config.zones, "deploy", label);
    return zone ? zoneHost(zone, config.baseDomain) : null;
}

/** The hostname Polaris's own dashboard lives on, or null when no domain is set. */
export async function polarisZoneHost(): Promise<string | null> {
    const config = await getDomainZones();
    if (!config.baseDomain) return null;
    const zone = pickZone(config.zones, "polaris");
    return zone ? zoneHost(zone, config.baseDomain) : null;
}

/**
 * A hostname for a service inside a deploy zone: deterministic from the name (so a
 * redeploy keeps the URL) or random when the caller wants an unguessable one. Null
 * when no domain is configured, so the caller falls back to a free subdomain.
 */
export async function deployHostname(
    name: string,
    options: { zoneLabel?: string; random?: boolean } = {}
): Promise<string | null> {
    const config = await getDomainZones();
    if (!config.baseDomain) return null;
    const zone = pickZone(config.zones, "deploy", options.zoneLabel);
    if (!zone) return null;
    return options.random
        ? randomZoneHostname(zone, config.baseDomain)
        : zoneHostname(name, zone, config.baseDomain);
}

/** The deploy zones offered in a picker, as `{ label, host }` pairs. */
export async function listDeployZones(): Promise<Array<{ label: string; host: string }>> {
    const config = await getDomainZones();
    if (!config.baseDomain) return [];
    return config.zones
        .filter((zone) => zone.scope === "deploy")
        .map((zone) => ({ label: zone.label, host: zoneHost(zone, config.baseDomain) }));
}
